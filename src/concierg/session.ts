import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { loadMessagePayload } from "../db/queries.js";
import { buildCleanEnv } from "../utils/env.js";
import { createChildLogger } from "../utils/logger.js";
import { captureException } from "../utils/sentry.js";
import type { IntentType } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// cwd for the SDK is the project root so .claude/agents, .claude/skills, and scripts/ all resolve.
const PROJECT_ROOT = join(__dirname, "..", "..");

const log = createChildLogger("concierg-session");

export interface ImageData {
  base64: string;
  mediaType: string;
  localPath: string;
}

/** Intent row published by the skill, hydrated for dispatcher consumption. */
export interface RegisteredIntent {
  id: number;
  type: IntentType;
  workerId: number | null;
  data: Record<string, unknown>;
}

const QUERY_TIMEOUT_MS = 600_000;

function findClaudeBinary(): string {
  if (process.env.CLAUDE_BINARY_PATH && existsSync(process.env.CLAUDE_BINARY_PATH)) {
    return process.env.CLAUDE_BINARY_PATH;
  }
  const localBin = pathJoin(homedir(), ".local", "bin", "claude");
  if (existsSync(localBin)) return localBin;
  try {
    const resolved = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {}
  return "claude";
}

const CLAUDE_BINARY = findClaudeBinary();

// --- ConciergSession ---
// Thin SDK wrapper. Each incoming Telegram message triggers a /process-telegram-message skill invocation.
// The skill does everything: load the message, classify, publish intents via CLI scripts, send the ack.
// This class just manages the persistent session id (resume across messages) and polls newly-inserted
// intent rows after each query to hand them back to the dispatcher.

export class ConciergSession {
  private sessionId: string | null = null;
  private alive = false;
  private busy = false;

  isAlive(): boolean {
    return this.alive;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async start(resumeSessionId?: string): Promise<void> {
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
      this.alive = true;
      log.info({ sessionId: resumeSessionId }, "Concierg session resumed from DB");
      return;
    }

    log.info("Bootstrapping concierg session");
    try {
      await this.runQuery("System initialized.");
    } catch (err) {
      log.warn({ err }, "Bootstrap query threw, checking if session id was captured");
    }

    if (this.sessionId) {
      this.alive = true;
      log.info({ sessionId: this.sessionId }, "Concierg session bootstrapped");
    } else {
      throw new Error("Failed to bootstrap concierg session — no session id received");
    }
  }

  async send(messageRowId: number, telegramMessageId: number): Promise<RegisteredIntent[]> {
    if (!this.sessionId) throw new Error("Concierg session not initialized");
    if (this.busy) throw new Error("Concierg session busy — concurrent send not supported");

    this.busy = true;
    const queryStart = new Date().toISOString().replace("T", " ").slice(0, 19);
    try {
      const payload = loadMessagePayload(messageRowId);
      if (!payload) throw new Error(`Message row ${messageRowId} not found`);
      const prompt = `/process-telegram-message\n\n${JSON.stringify(payload, null, 2)}`;
      await this.runQuery(prompt);
    } finally {
      this.busy = false;
    }

    return this.collectNewIntents(telegramMessageId, queryStart);
  }

  async ping(): Promise<boolean> {
    return this.alive && !!this.sessionId;
  }

  async stop(): Promise<void> {
    log.info("Stopping concierg session");
    this.alive = false;
  }

  // --- Internal ---

  private collectNewIntents(telegramMessageId: number, queryStart: string): RegisteredIntent[] {
    const rows = getDb()
      .select()
      .from(schema.intents)
      .where(and(eq(schema.intents.processed, false), gte(schema.intents.createdAt, queryStart)))
      .orderBy(schema.intents.id)
      .all();

    // Backfill telegram_message_id on intents the skill inserted with 0.
    for (const r of rows) {
      if (r.telegramMessageId === 0 && telegramMessageId) {
        getDb()
          .update(schema.intents)
          .set({ telegramMessageId })
          .where(eq(schema.intents.id, r.id))
          .run();
      }
    }

    return rows.map((r) => ({
      id: r.id,
      type: r.type as IntentType,
      workerId: r.workerId,
      data: (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>,
    }));
  }

  private async runQuery(prompt: string): Promise<void> {
    const abortController = new AbortController();
    const env = buildCleanEnv();
    // Ensure CLAUDE_PROJECT_DIR is set so skill can invoke $CLAUDE_PROJECT_DIR/scripts/*.
    env.CLAUDE_PROJECT_DIR = PROJECT_ROOT;

    // Defense in depth — skill's allowed-tools should already gate this.
    const canUseTool: CanUseTool = async (toolName, input) => {
      if (
        toolName === "Read" ||
        toolName === "TodoWrite" ||
        toolName === "Agent" ||
        (toolName === "Bash" && typeof (input as any)?.command === "string" &&
          (input as any).command.includes(`${PROJECT_ROOT}/scripts/`))
      ) {
        return { behavior: "allow" as const, updatedInput: input };
      }
      log.warn({ toolName, input }, "Concierg attempted to use blocked tool");
      return {
        behavior: "deny" as const,
        message: `Blocked: ${toolName} is not allowed here. Only ${PROJECT_ROOT}/scripts/* via Bash, plus Read/TodoWrite.`,
      };
    };

    const conversation = query({
      prompt,
      options: {
        model: "claude-opus-4-7",
        effort: "high",
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project"],
        allowedTools: ["Skill", "Bash", "Read", "TodoWrite", "Agent"],
        maxTurns: 50,
        cwd: PROJECT_ROOT,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        env,
        abortController,
        canUseTool,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      },
    });

    const processMessages = async () => {
      for await (const message of conversation) {
        if (message.type === "system" && message.subtype === "init") {
          this.sessionId = message.session_id;
          log.info({ sessionId: message.session_id }, "Concierg session initialized");
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            log.info(
              { turns: message.num_turns, cost: message.total_cost_usd.toFixed(4) },
              "Concierg query completed",
            );
          } else {
            log.warn(
              { subtype: message.subtype, turns: message.num_turns },
              "Concierg query finished with non-success",
            );
          }
        }
      }
    };

    let timeoutId: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        processMessages(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            log.warn("SDK query timed out after %dms, aborting", QUERY_TIMEOUT_MS);
            abortController.abort();
            reject(new Error(`Claude Code SDK query timed out after ${QUERY_TIMEOUT_MS / 1000}s`));
          }, QUERY_TIMEOUT_MS);
        }),
      ]);
    } catch (err: any) {
      if (err?.message?.includes("exited with code 1")) {
        log.warn("SDK exited with code 1, proceeding with intents polled from DB");
      } else {
        log.error({ err }, "Concierg query error");
        captureException(err);
      }
    } finally {
      clearTimeout(timeoutId!);
    }
  }
}
