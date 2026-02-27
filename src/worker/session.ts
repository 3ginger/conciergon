import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type CanUseTool,
  type HookCallback,
} from "@anthropic-ai/claude-code";
import {
  updateWorkerState,
  updateWorkerSessionId,
  touchWorkerActivity,
  insertEvent,
  insertPendingQuestion,
  updateQuestionTelegramMessageId,
  answerQuestion,
} from "../db/queries.js";
import { WorkerState } from "../types/index.js";
import type { AskUserQuestionItem } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { buildCleanEnv } from "../utils/env.js";
import { createWorkerMcpServer, type WorkerMcpContext } from "./mcp-tools.js";

const log = createChildLogger("worker");

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

function findClaudeBinary(): string {
  if (process.env.CLAUDE_BINARY_PATH && existsSync(process.env.CLAUDE_BINARY_PATH)) {
    return process.env.CLAUDE_BINARY_PATH;
  }
  const localBin = pathJoin(homedir(), ".local", "bin", "claude");
  if (existsSync(localBin)) return localBin;
  try {
    const resolved = execSync("which claude", { encoding: "utf-8" }).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {}
  return "claude";
}

const CLAUDE_BINARY = findClaudeBinary();

/** Reformat a plan for Telegram using a quick Haiku call. Falls back to raw text on error. */
async function formatPlanForTelegram(planText: string): Promise<string> {
  try {
    const conversation = query({
      prompt: planText,
      options: {
        model: "claude-haiku-4-5-20251001",
        appendSystemPrompt: "Reformat the following plan for Telegram messenger. Rules: no markdown tables (use bullet points instead), no triple-backtick code blocks (indent with spaces or use inline `code`), keep it concise and scannable, preserve all important info. Output ONLY the reformatted text, nothing else.",
        maxTurns: 1,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
      },
    });
    let result = "";
    for await (const msg of conversation) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") result += block.text;
        }
      }
    }
    return result.trim() || planText;
  } catch (err) {
    log.warn({ err }, "Failed to reformat plan for Telegram, using raw text");
    return planText;
  }
}

export type CompletionHandler = (
  workerId: number,
  result: SDKResultMessage
) => void;

/**
 * Parse AskUserQuestion structured input into readable text + structured items.
 * Handles both { questions: [...] } and legacy { question: string }.
 */
function parseAskUserQuestion(input: unknown): { text: string; questions: AskUserQuestionItem[] } {
  const inp = input as Record<string, unknown>;

  if (Array.isArray(inp.questions)) {
    const questions: AskUserQuestionItem[] = (inp.questions as any[]).map((q) => ({
      question: String(q.question || ""),
      header: String(q.header || ""),
      multiSelect: Boolean(q.multiSelect),
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({
            label: String(o.label || ""),
            description: String(o.description || ""),
          }))
        : [],
    }));

    const textParts = questions.map((q) => {
      let text = "";
      if (q.header) text += `${q.header}: `;
      text += q.question;
      if (q.options.length > 0) {
        text += "\n" + q.options
          .map((o, j) => `  ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`)
          .join("\n");
      }
      if (q.multiSelect) text += "\n  (multiple selections allowed)";
      return text;
    });

    return { text: textParts.join("\n\n"), questions };
  }

  if (typeof inp.question === "string") {
    return { text: inp.question, questions: [] };
  }

  return { text: JSON.stringify(input), questions: [] };
}

interface WorkerEvent {
  timestamp: Date;
  type: 'stdout' | 'stderr' | 'tool' | 'state' | 'message' | 'error';
  content: string;
}

/** Extract a short text preview from an SDK assistant message's content field. */
function extractContentPreview(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, 200);
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text);
    return textParts.length > 0 ? textParts.join(" ").slice(0, 200) : "(using tools)";
  }
  return "(unknown content)";
}

function summarizeToolUse(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case 'Read':   return `Reading ${inp.file_path || 'file'}`;
    case 'Write':  return `Writing ${inp.file_path || 'file'}`;
    case 'Edit':   return `Editing ${inp.file_path || 'file'}`;
    case 'Grep':   return `Searching for "${inp.pattern}" in ${inp.path || 'codebase'}`;
    case 'Glob':   return `Finding files matching ${inp.pattern || '*'}`;
    case 'Bash':   return `Running: ${String(inp.command || '').slice(0, 80)}`;
    case 'Task':   return `Delegating subtask`;
    default:       return `Using ${toolName}`;
  }
}

/**
 * Context for direct Telegram communication from the worker.
 */
export interface WorkerTelegramContext {
  chatId: number;
  emoji: string;
  sendMessage: (chatId: number, text: string) => Promise<number>;
  /** Send a long markdown message, auto-chunked and formatted for Telegram HTML */
  sendLongMessage: (chatId: number, text: string) => Promise<number[]>;
  sendQuestionMessage: (
    chatId: number,
    workerId: number,
    questionId: number,
    question: string,
    options?: Array<{ label: string; description?: string }>,
    multiSelect?: boolean,
    emoji?: string,
  ) => Promise<number>;
  sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<number>;
  /** Track which worker sent which Telegram message (for reply routing) */
  trackMessage: (telegramMsgId: number, workerId: number) => void;
}

export class WorkerLLM {
  readonly id: number;
  readonly projectPath: string;
  readonly prompt: string;
  private _permissionMode: 'plan' | 'default';

  private query: Query | null = null;
  private abortController = new AbortController();
  private sessionId: string | null = null;
  private _state: WorkerState = WorkerState.Starting;
  private pendingFollowUp: string | null = null;
  private followUpSignal: { resolve: (msg: string) => void } | null = null;
  private _totalCostUsd = 0;
  private planApproved = false;

  private eventBuffer: WorkerEvent[] = [];
  private readonly MAX_EVENTS = 100;
  private lastStdout = "";
  private lastStderr = "";

  /** Telegram context for direct communication */
  private telegramCtx: WorkerTelegramContext;

  /** Per-worker MCP server for Telegram tools */
  private workerMcpServer: ReturnType<typeof createWorkerMcpServer>;

  /** In-memory question resolvers (keyed by questionId) */
  private questionResolvers = new Map<number, (answer: string) => void>();

  /** Plan review resolver (only one at a time) */
  private planResolver: ((decision: string) => void) | null = null;

  onCompletion: CompletionHandler | null = null;

  constructor(
    id: number,
    projectPath: string,
    prompt: string,
    telegramCtx: WorkerTelegramContext,
    permissionMode: 'plan' | 'default' = 'plan',
  ) {
    this.id = id;
    this.projectPath = projectPath;
    this.prompt = prompt;
    this.telegramCtx = telegramCtx;
    this._permissionMode = permissionMode;

    // Create per-worker MCP server
    const mcpCtx: WorkerMcpContext = {
      workerId: id,
      emoji: telegramCtx.emoji,
      chatId: telegramCtx.chatId,
      sendMessage: telegramCtx.sendMessage,
      sendPhoto: telegramCtx.sendPhoto,
      trackMessage: telegramCtx.trackMessage,
    };
    this.workerMcpServer = createWorkerMcpServer(mcpCtx);
  }

  get state(): WorkerState {
    return this._state;
  }

  get permissionMode(): 'plan' | 'default' {
    return this._permissionMode;
  }

  get phase(): 'planning' | 'executing' {
    return this.planApproved ? 'executing' : 'planning';
  }

  /**
   * Switch worker back to planning mode.
   * Takes effect on the NEXT query (after current follow-up interrupt).
   */
  switchToPlanning(): void {
    this._permissionMode = 'plan';
    this.planApproved = false;
    log.info({ workerId: this.id }, "Switched to planning mode");
    this.addEvent('state', 'Switched to planning mode');
    insertEvent(this.id, "mode_switch", { mode: "plan" });
  }

  /**
   * Switch worker to execution mode (skip planning).
   * Takes effect on the NEXT query (after current follow-up interrupt).
   */
  switchToExecution(): void {
    this._permissionMode = 'default';
    this.planApproved = true;
    log.info({ workerId: this.id }, "Switched to execution mode");
    this.addEvent('state', 'Switched to execution mode');
    insertEvent(this.id, "mode_switch", { mode: "default" });
  }

  private setState(state: WorkerState) {
    this._state = state;
    updateWorkerState(this.id, state);
    insertEvent(this.id, "status_change", { state });
    this.addEvent('state', `State changed to: ${state}`);
  }

  private addEvent(type: WorkerEvent['type'], content: string) {
    const event: WorkerEvent = {
      timestamp: new Date(),
      type,
      content: content.slice(0, 500) // Limit content size
    };

    this.eventBuffer.push(event);

    // Keep only last MAX_EVENTS
    if (this.eventBuffer.length > this.MAX_EVENTS) {
      this.eventBuffer.shift();
    }
  }

  getRecentEvents(count: number = 20): WorkerEvent[] {
    return this.eventBuffer.slice(-count);
  }

  getLastOutput(): { stdout: string; stderr: string; events: WorkerEvent[] } {
    return {
      stdout: this.lastStdout,
      stderr: this.lastStderr,
      events: this.getRecentEvents()
    };
  }

  get totalCostUsd(): number {
    return this._totalCostUsd;
  }

  /** Build a synthetic error result for notifying of failures. */
  private makeErrorResult(): SDKResultMessage {
    return {
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0,
      num_turns: 0,
      session_id: this.sessionId || "",
    } as unknown as SDKResultMessage;
  }

  /** Resolve a pending question by its ID */
  resolveQuestion(questionId: number, answer: string): boolean {
    const resolver = this.questionResolvers.get(questionId);
    if (resolver) {
      answerQuestion(questionId, answer);
      resolver(answer);
      this.questionResolvers.delete(questionId);
      log.info({ questionId, answer, workerId: this.id }, "Question resolved");
      return true;
    }
    return false;
  }

  /** Resolve a pending plan review */
  resolvePlan(decision: string): boolean {
    if (this.planResolver) {
      this.planResolver(decision);
      this.planResolver = null;
      log.info({ workerId: this.id, decision: decision.slice(0, 50) }, "Plan resolved");
      return true;
    }
    return false;
  }

  /** Check if this worker has a pending question with the given ID */
  hasQuestion(questionId: number): boolean {
    return this.questionResolvers.has(questionId);
  }

  /** Check if this worker has a pending plan review */
  hasPendingPlan(): boolean {
    return this.planResolver !== null;
  }

  private waitForFollowUp(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.abortController.signal.aborted) {
        reject(new DOMException("Worker dismissed", "AbortError"));
        return;
      }
      this.followUpSignal = { resolve };
      this.abortController.signal.addEventListener('abort', () => {
        this.followUpSignal = null;
        reject(new DOMException("Worker dismissed", "AbortError"));
      }, { once: true });
    });
  }

  async start(resumeSessionId?: string): Promise<void> {
    log.info({ workerId: this.id, project: this.projectPath }, "Starting worker");

    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      // Intercept AskUserQuestion — send directly to Telegram
      if (toolName === "AskUserQuestion") {
        const parsed = parseAskUserQuestion(input);

        this.setState(WorkerState.WaitingInput);

        // Insert question in DB
        const questionRow = insertPendingQuestion(this.id, parsed.text, "");

        // Extract structured options for inline keyboard
        const structuredOptions = parsed.questions.length > 0
          ? parsed.questions.flatMap(q => q.options)
          : undefined;
        const multiSelect = parsed.questions.some(q => q.multiSelect);

        // Send question directly to Telegram with buttons
        const telegramMsgId = await this.telegramCtx.sendQuestionMessage(
          this.telegramCtx.chatId,
          this.id,
          questionRow.id,
          parsed.text,
          structuredOptions && structuredOptions.length > 0 ? structuredOptions : undefined,
          multiSelect,
          this.telegramCtx.emoji,
        );

        // Track message for reply routing
        updateQuestionTelegramMessageId(questionRow.id, telegramMsgId);
        this.telegramCtx.trackMessage(telegramMsgId, this.id);

        // Wait for user to answer (via button tap or reply)
        const answer = await new Promise<string>((resolve) => {
          this.questionResolvers.set(questionRow.id, resolve);
        });

        this.setState(WorkerState.Active);

        return {
          behavior: "deny" as const,
          message: answer,
        };
      }

      // Intercept ExitPlanMode — send plan directly to Telegram
      if (toolName === "ExitPlanMode" && this._permissionMode === 'plan') {
        // Guard: if a plan is already pending approval, don't send a duplicate
        if (this.planResolver) {
          return { behavior: "deny" as const, message: "A plan is already pending approval. Wait for the user to respond." };
        }

        const rawPlan = (input as any).plan || JSON.stringify(input);

        // Guard against empty plans (e.g. '{}' when ExitPlanMode called without plan field)
        if (!rawPlan || rawPlan.trim() === '' || rawPlan.trim() === '{}') {
          return {
            behavior: "deny" as const,
            message: 'Your plan is empty. Please include the full plan text in the ExitPlanMode call (plan field).',
          };
        }

        this.setState(WorkerState.WaitingInput);

        // Reformat plan for Telegram (no tables, concise) then send with proper HTML formatting
        const formattedPlan = await formatPlanForTelegram(rawPlan);
        const planText = `${this.telegramCtx.emoji} Worker #${this.id} submitted a plan:\n\n${formattedPlan}`;
        const msgIds = await this.telegramCtx.sendLongMessage(this.telegramCtx.chatId, planText);
        for (const mid of msgIds) {
          this.telegramCtx.trackMessage(mid, this.id);
        }

        // Wait for user to approve/reject
        const decision = await new Promise<string>((resolve) => {
          this.planResolver = resolve;
        });

        this.setState(WorkerState.Active);

        const trimmed = decision.trimStart();
        if (trimmed.startsWith("APPROVED:")) {
          this.planApproved = true;
          return { behavior: "allow" as const, updatedInput: input };
        } else {
          const feedback = trimmed.startsWith("REJECTED:")
            ? trimmed.slice("REJECTED:".length).trim()
            : decision;
          return { behavior: "deny" as const, message: feedback };
        }
      }

      // Allow worker's own MCP tools and standard tools
      return { behavior: "allow" as const, updatedInput: input };
    };

    const postToolUseHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name === "PostToolUse") {
        touchWorkerActivity(this.id);
        insertEvent(this.id, "tool_use", {
          tool: hookInput.tool_name,
          input: hookInput.tool_input,
        });

        // Capture tool usage in event buffer
        this.addEvent('tool', summarizeToolUse(hookInput.tool_name, hookInput.tool_input));

        // If it's a Bash tool, try to capture output
        if (hookInput.tool_name === 'Bash' && hookInput.tool_response) {
          const output = typeof hookInput.tool_response === 'string'
            ? hookInput.tool_response
            : JSON.stringify(hookInput.tool_response);

          // Store last stdout for status queries
          this.lastStdout = output.slice(-2000); // Keep last 2000 chars
          this.addEvent('stdout', output.slice(0, 500));
        }
      }
      return {};
    };

    const notificationHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name === "Notification") {
        // Send notification directly to Telegram
        const title = hookInput.title ? `${hookInput.title}: ` : "";
        const text = `${this.telegramCtx.emoji} #${this.id} ${title}${hookInput.message}`;
        try {
          const msgId = await this.telegramCtx.sendMessage(this.telegramCtx.chatId, text);
          this.telegramCtx.trackMessage(msgId, this.id);
        } catch (err) {
          log.error({ err, workerId: this.id }, "Failed to send notification to Telegram");
        }
      }
      return {};
    };

    const preCompactHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name === "PreCompact") {
        const text = `${this.telegramCtx.emoji} #${this.id} Context limit (${hookInput.trigger}). Auto-compacting.`;
        try {
          await this.telegramCtx.sendMessage(this.telegramCtx.chatId, text);
        } catch (err) {
          log.error({ err, workerId: this.id }, "Failed to send compact notification");
        }
      }
      return {};
    };

    const workerEnv = buildCleanEnv();

    let currentPrompt = this.prompt;
    let resumeId = resumeSessionId;

    // Outer loop: re-enters when a follow-up interrupts the current query
    while (true) {
      const options: Options = {
        model: "claude-opus-4-6",
        cwd: this.projectPath,
        permissionMode: this._permissionMode,
        allowedTools: ["mcp__worker_telegram__*"],
        canUseTool,
        abortController: this.abortController,
        env: workerEnv,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        mcpServers: { worker_telegram: this.workerMcpServer },
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
          Notification: [{ hooks: [notificationHook] }],
          PreCompact: [{ hooks: [preCompactHook] }],
        },
        ...(resumeId ? { resume: resumeId } : {}),
      };

      this.query = query({ prompt: currentPrompt, options });
      this.setState(WorkerState.Active);

      let followUpToProcess: string | null = null;

      try {
        for await (const message of this.query) {
          touchWorkerActivity(this.id);

          if (message.type === "system" && message.subtype === "init") {
            this.sessionId = message.session_id;
            updateWorkerSessionId(this.id, message.session_id);
            log.info(
              { workerId: this.id, sessionId: message.session_id },
              "Worker session started"
            );
            this.addEvent('message', 'Session initialized');
          }

          if (message.type === "assistant" && (message as any).message?.content) {
            const preview = extractContentPreview((message as any).message.content);
            this.addEvent("message", `Assistant: ${preview}`);
          }

          if (message.type === "result") {
            // Check if a follow-up is pending (interrupt was triggered)
            if (this.pendingFollowUp) {
              followUpToProcess = this.pendingFollowUp;
              this.pendingFollowUp = null;
              log.info(
                { workerId: this.id },
                "Interrupted for follow-up, will resume"
              );
              break;
            }

            const result = message as SDKResultMessage;
            this._totalCostUsd += result.total_cost_usd;

            // Completion — send result directly to Telegram
            touchWorkerActivity(this.id);
            this.handleCompletion(result);

            // Mark that result was delivered (prevents re-sending on restart)
            insertEvent(this.id, "result_delivered", { subtype: result.subtype });

            try {
              const nextMsg = await this.waitForFollowUp();
              followUpToProcess = nextMsg;
              break; // outer loop resumes with new query
            } catch (e) {
              if ((e as Error).name === "AbortError") {
                return;
              }
              throw e;
            }
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
          log.info({ workerId: this.id }, "Worker aborted");
          this.addEvent('message', 'Worker aborted by user');
          return;
        }
        this.setState(WorkerState.Errored);
        log.error({ workerId: this.id, err }, "Worker error");
        insertEvent(this.id, "error", {
          message: (err as Error).message,
        });

        const errorMsg = (err as Error).message || 'Unknown error';
        this.lastStderr = errorMsg;
        this.addEvent('error', errorMsg);

        // Send error to Telegram and notify completion handler
        try {
          const text = `${this.telegramCtx.emoji} #${this.id} Error: ${errorMsg.slice(0, 500)}`;
          await this.telegramCtx.sendMessage(this.telegramCtx.chatId, text);
        } catch { /* ignore send errors */ }

        this.onCompletion?.(this.id, this.makeErrorResult());

        // Wait for follow-up (user may push worker to retry)
        try {
          const nextMsg = await this.waitForFollowUp();
          followUpToProcess = nextMsg;
          // Fall through to the follow-up resume logic below
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            return;
          }
          throw e;
        }
      }

      // If we have a follow-up, resume with it
      if (followUpToProcess && this.sessionId) {
        currentPrompt = followUpToProcess;
        resumeId = this.sessionId;
        continue;
      }

      // No follow-up and no session — guard against silent exit
      if (!followUpToProcess) {
        this.setState(WorkerState.Errored);
        this.onCompletion?.(this.id, this.makeErrorResult());
        return;
      }
    }
  }

  /** Handle worker completion — send result directly to Telegram */
  private handleCompletion(result: SDKResultMessage): void {
    const cost = result.total_cost_usd.toFixed(4);
    const totalCost = this._totalCostUsd.toFixed(4);
    const resultText = result.subtype === "success"
      ? result.result?.slice(0, 1000) || "(no output)"
      : `(error: ${result.subtype})`;

    const text = `${this.telegramCtx.emoji} #${this.id} completed (${result.subtype})\nCost: $${cost} | Total: $${totalCost}\n\n${resultText}`;

    this.telegramCtx.sendMessage(this.telegramCtx.chatId, text)
      .then((msgId) => this.telegramCtx.trackMessage(msgId, this.id))
      .catch((err) => log.error({ err, workerId: this.id }, "Failed to send completion to Telegram"));

    insertEvent(this.id, "result", {
      subtype: result.subtype,
      cost: result.total_cost_usd,
      turns: result.num_turns,
    });

    this.onCompletion?.(this.id, result);
  }

  async followUp(message: string): Promise<void> {
    if (this.followUpSignal) {
      // Worker is waiting for follow-up, wake it up
      this.followUpSignal.resolve(message);
      this.followUpSignal = null;
      return;
    }
    if (this.query) {
      // Worker is active, interrupt
      this.pendingFollowUp = message;
      await this.query.interrupt();
      return;
    }
    throw new Error(`Worker #${this.id} cannot accept follow-ups`);
  }

  async interrupt(): Promise<void> {
    if (this.query) {
      await this.query.interrupt();
    }
  }

  abort(): void {
    this.abortController.abort();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** True if start() hasn't been called yet (cold-registered, no active SDK query). */
  isCold(): boolean {
    return this.query === null && this.followUpSignal === null;
  }

  /** Wake a cold worker by starting its SDK session. */
  async warmUp(resumeSessionId: string): Promise<void> {
    if (!this.isCold()) {
      throw new Error(`Worker #${this.id} is already warm`);
    }
    this.sessionId = resumeSessionId;
    await this.start(resumeSessionId);
  }
}
