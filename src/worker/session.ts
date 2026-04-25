import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type CanUseTool,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import {
  updateWorkerState,
  updateWorkerSessionId,
  updateWorkerPermissionMode,
  touchWorkerActivity,
  getWorkerMessagesSince,
  getWorkerRecentMessages,
} from "../db/queries.js";
import { insertEvent, getEventsSinceLastTask } from "../db/message-log.js";
import { WorkerState } from "../types/index.js";
import type { AskUserQuestionItem } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { buildCleanEnv } from "../utils/env.js";
import type { SendContext } from "../telegram/index.js";

const log = createChildLogger("worker");

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { markdownToHtmlDocument } from "../markdown/index.js";
import { homedir } from "node:os";
import { dirname, join, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

const FORMATTER_EVENT_TYPES = new Set([
  "worker_spawning", "follow_up",
  "tool_use", "assistant_message",
  "question_asked", "question_answered",
  "plan_proposed", "plan_approved", "plan_rejected",
]);

type FormatterSkill = "format-plan" | "format-result" | "format-question";

type PlanOutcome = { kind: "approve" } | { kind: "reject"; prompt: string };

async function formatText(opts: {
  skill: FormatterSkill;
  input: Record<string, unknown>;
  label: string;
}): Promise<string> {
  const noTools: CanUseTool = async () => ({
    behavior: "deny" as const,
    message: "No tools. Output the formatted text directly as plain text.",
  });

  const prompt = `/${opts.skill}\n\n${JSON.stringify(opts.input)}`;

  const conversation = query({
    prompt,
    options: {
      model: "claude-opus-4-7",
      effort: "medium",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      maxTurns: 2,
      cwd: PROJECT_ROOT,
      canUseTool: noTools,
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
      env: buildCleanEnv(),
    },
  });

  let result = "";
  try {
    for await (const msg of conversation) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") result += block.text;
        }
      }
    }
  } catch (err: any) {
    if (err?.message?.includes("exited with code 1")) {
      log.warn(`Formatter exited with code 1 (${opts.label}), using accumulated output`);
    } else {
      log.warn({ err }, `Formatter error in ${opts.label}`);
    }
  }
  return result.trim();
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/** Parse AskUserQuestion structured input into readable text + structured items. */
function parseAskUserQuestion(input: unknown): { text: string; questions: AskUserQuestionItem[] } {
  const inp = input as Record<string, unknown>;

  if (!Array.isArray(inp.questions)) {
    return { text: JSON.stringify(input), questions: [] };
  }

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

/**
 * Context for direct Telegram communication from the worker.
 */
export interface WorkerTelegramContext {
  chatId: number;
  emoji: string;
  workerId: number;
  sendMessage: (chatId: number, text: string) => Promise<number>;
  /** Send a long markdown message, auto-chunked and formatted for Telegram HTML */
  sendLongMessage: (chatId: number, text: string, contextOverride?: import("../telegram/index.js").SendContext) => Promise<number[]>;
  sendQuestionMessage: (
    chatId: number,
    workerId: number,
    question: string,
    emoji?: string,
    mode?: string,
  ) => Promise<number>;
  sendDocument: (chatId: number, filePath: string, caption?: string, contextOverride?: import("../telegram/index.js").SendContext) => Promise<number>;
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
  private planApproved = false;

  /** Telegram context for direct communication */
  private telegramCtx: WorkerTelegramContext;

  /** In-memory question resolver (one at a time — worker is blocked) */
  private questionResolver: ((answer: string) => void) | null = null;

  /** Plan review resolver (only one at a time) */
  private planResolver: ((outcome: PlanOutcome) => void) | null = null;

  /** Follow-up question tracking for plan mode batching */
  private followUpQuestion: string | null = null;
  private followUpTimestamp: string | null = null;
  private lastPlanHash: string | null = null;

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
  }

  /** Short mode label for Telegram titles */
  get modeTag(): string {
    return this._permissionMode === 'plan' ? 'plan' : 'exec';
  }

  /** Insert an event linked to this worker's intent */
  private logEvent(type: import("../types/index.js").EventType, data?: Record<string, unknown>, messageId?: number | null) {
    touchWorkerActivity(this.id);
    insertEvent({
      workerId: this.id,
      type,
      data,
      messageId: messageId ?? null,
    });
  }

  get state(): WorkerState {
    return this._state;
  }

  get permissionMode(): 'plan' | 'default' {
    return this._permissionMode;
  }

  /** Restore plan state from DB (used when resuming/cold-registering). */
  restorePlanState(mode: 'plan' | 'default'): void {
    this._permissionMode = mode;
    this.planApproved = mode === 'default';
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
    updateWorkerPermissionMode(this.id, 'plan');
    log.info({ workerId: this.id }, "Switched to planning mode");
    this.logEvent("mode_switch", { to: "plan" });
  }

  /**
   * Switch worker to execution mode (skip planning).
   * Takes effect on the NEXT query (after current follow-up interrupt).
   */
  switchToExecution(): void {
    this._permissionMode = 'default';
    this.planApproved = true;
    updateWorkerPermissionMode(this.id, 'default');
    log.info({ workerId: this.id }, "Switched to execution mode");
    this.logEvent("mode_switch", { to: "execution" });
  }

  private setState(state: WorkerState) {
    this._state = state;
    updateWorkerState(this.id, state);
    this.logEvent("status_change", { state });
  }

  /** Resolve the pending question */
  resolveQuestion(answer: string): boolean {
    if (this.questionResolver) {
      this.questionResolver(answer);
      this.questionResolver = null;
      log.info({ answer: answer.slice(0, 50), workerId: this.id }, "Question resolved");
      return true;
    }
    return false;
  }

  approvePlan(): boolean {
    if (!this.planResolver) return false;
    this.planResolver({ kind: "approve" });
    this.planResolver = null;
    log.info({ workerId: this.id }, "Plan approved");
    return true;
  }

  rejectPlan(prompt: string): boolean {
    if (!this.planResolver) return false;
    this.planResolver({ kind: "reject", prompt });
    this.planResolver = null;
    log.info({ workerId: this.id }, "Plan rejected");
    return true;
  }

  /** Check if this worker has a pending question with the given ID */
  hasQuestion(): boolean {
    return this.questionResolver !== null;
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

  async start(resumeSessionId?: string, overridePrompt?: string): Promise<void> {
    log.info({ workerId: this.id, project: this.projectPath }, "Starting worker");

    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      // Intercept AskUserQuestion — send directly to Telegram
      if (toolName === "AskUserQuestion") {
        const parsed = parseAskUserQuestion(input);

        this.setState(WorkerState.WaitingInput);

        this.logEvent("question_asked", { question: parsed.text });

        const formattedText = await this.callFormatter({ skill: "format-question", input: { question: JSON.stringify(input) }, label: "question" });

        await this.telegramCtx.sendQuestionMessage(
          this.telegramCtx.chatId,
          this.id,
          formattedText,
          this.telegramCtx.emoji,
          this.modeTag,
        );

        const answer = await new Promise<string>((resolve) => {
          this.questionResolver = resolve;
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

        const planHash = simpleHash(rawPlan);
        const planChanged = this.lastPlanHash !== planHash;
        this.lastPlanHash = planHash;

        if (this.followUpQuestion && this.followUpTimestamp) {
          // Follow-up path: bundle worker messages + plan → single formatted answer
          const messages = getWorkerMessagesSince(this.id, this.followUpTimestamp);
          const workerText = messages
            .map((m) => {
              const data = typeof m.data === "string" ? JSON.parse(m.data) : m.data;
              return (data as any)?.text || "";
            })
            .filter(Boolean)
            .join("\n\n");

          if (!workerText && !planChanged) {
            log.warn({ workerId: this.id }, "Follow-up ExitPlanMode with no content — denying");
            this.followUpQuestion = null;
            this.followUpTimestamp = null;
            return {
              behavior: "deny" as const,
              message: "Your response was too brief. Provide a substantive answer to the user's question before calling ExitPlanMode.",
            };
          }

          const bundle = [
            `USER QUESTION: ${this.followUpQuestion}`,
            `PLAN_CHANGED=${planChanged}`,
            workerText ? `WORKER RESPONSE:\n${workerText}` : "",
            planChanged ? `UPDATED PLAN:\n${rawPlan}` : "",
          ].filter(Boolean).join("\n\n");

          const formatted = await this.callFormatter({ skill: "format-result", input: { result: bundle }, label: "follow-up answer" });
          this.logEvent("formatter_done", { context: "follow_up_answer" });
          const text = `${this.telegramCtx.emoji} #${this.id} [${this.modeTag}]:\n\n${formatted}`;
          const planCtx: SendContext = { source: "worker_plan", workerId: this.id };
          await this.telegramCtx.sendLongMessage(this.telegramCtx.chatId, text, planCtx);

          this.followUpQuestion = null;
          this.followUpTimestamp = null;
        } else {
          // First plan: save as file + send formatted summary
          this.logEvent("plan_proposed", { text: rawPlan });

          // Save full plan as styled HTML file
          const planDir = join(process.cwd(), "data", "plans");
          mkdirSync(planDir, { recursive: true });
          const planFile = join(planDir, `worker_${this.id}_plan_${Date.now()}.html`);
          writeFileSync(planFile, markdownToHtmlDocument(rawPlan, { title: `Worker #${this.id} Plan` }));

          // Send file first (non-blocking: text summary must always be delivered)
          const planCtx: SendContext = { source: "worker_plan", workerId: this.id };
          try {
            await this.telegramCtx.sendDocument(
              this.telegramCtx.chatId, planFile,
              `${this.telegramCtx.emoji} #${this.id} [plan] — tap to read full plan`,
              planCtx,
            );
          } catch (err) {
            this.logEvent("plan_document_send_failed", { error: (err as Error).message, planFile });
          }

          // Send formatted summary
          const formattedPlan = await this.callFormatter({ skill: "format-plan", input: { plan: rawPlan }, label: "plan" });
          this.logEvent("formatter_done", { context: "plan" });
          const planText = `${this.telegramCtx.emoji} #${this.id} [plan]:\n\n${formattedPlan}\n\nReply "approve" to proceed or "reject" with feedback.`;
          await this.telegramCtx.sendLongMessage(this.telegramCtx.chatId, planText, planCtx);
        }

        // Wait for user to approve/reject
        const outcome = await new Promise<PlanOutcome>((resolve) => {
          this.planResolver = resolve;
        });

        this.setState(WorkerState.Active);

        if (outcome.kind === "approve") {
          this.switchToExecution();
          return { behavior: "allow" as const, updatedInput: input };
        }
        return { behavior: "deny" as const, message: outcome.prompt };
      }

      // Allow worker's own MCP tools and standard tools
      return { behavior: "allow" as const, updatedInput: input };
    };

    const postToolUseHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name === "PostToolUse") {
        const toolData = { tool: hookInput.tool_name, input: hookInput.tool_input };
        this.logEvent("tool_use", toolData);

        // Capture tool usage in event buffer

        // If it's a Bash tool, try to capture output
        if (hookInput.tool_name === 'Bash' && hookInput.tool_response) {
          const output = typeof hookInput.tool_response === 'string'
            ? hookInput.tool_response
            : JSON.stringify(hookInput.tool_response);

        }
      }
      return {};
    };

    const preCompactHook: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name === "PreCompact") {
        log.info({ workerId: this.id, trigger: hookInput.trigger }, "Context compacting");
      }
      return {};
    };

    const workerEnv = buildCleanEnv();

    let currentPrompt = overridePrompt ?? this.prompt;
    let resumeId = resumeSessionId;

    // Outer loop: re-enters when a follow-up interrupts the current query
    while (true) {
      const options: Options = {
        model: "claude-opus-4-7",
        effort: "max",
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project"],
        cwd: this.projectPath,
        permissionMode: this._permissionMode,
        canUseTool,
        abortController: this.abortController,
        env: workerEnv,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [preCompactHook] }],
        },
        ...(resumeId ? { resume: resumeId } : {}),
      };

      this.query = query({ prompt: currentPrompt, options });
      this.setState(WorkerState.Active);

      let followUpToProcess: string | null = null;

      try {
        for await (const message of this.query) {
          if (message.type === "system" && message.subtype === "init") {
            this.sessionId = message.session_id;
            updateWorkerSessionId(this.id, message.session_id);
            log.info(
              { workerId: this.id, sessionId: message.session_id },
              "Worker session started"
            );
            this.logEvent("worker_started", { sessionId: message.session_id });
          }

          if (message.type === "assistant" && (message as any).message?.content) {
            const content = (message as any).message.content;
            const preview = extractContentPreview(content);

            // Save full assistant text to DB for progress tracking and follow-up answers
            const fullText = Array.isArray(content)
              ? content.filter((b: any) => b.type === "text" && b.text).map((b: any) => b.text).join("\n")
              : typeof content === "string" ? content : "";
            if (fullText) {
              this.logEvent("assistant_message", { text: fullText });
            }
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

            // Completion — send result directly to Telegram
            await this.handleCompletion(result);

            // Mark that result was delivered (prevents re-sending on restart)
            this.logEvent("result_delivered", { subtype: result.subtype });

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
          return;
        }
        this.setState(WorkerState.Errored);
        log.error({ workerId: this.id, err }, "Worker error");
        this.logEvent("worker_error", { message: (err as Error).message });

        const errorMsg = (err as Error).message || 'Unknown error';

        // Send error to Telegram and notify completion handler
        try {
          const text = `${this.telegramCtx.emoji} #${this.id} [${this.modeTag}] Error: ${errorMsg.slice(0, 500)}`;
          await this.telegramCtx.sendMessage(this.telegramCtx.chatId, text);
        } catch { /* ignore send errors */ }


        // Use pending follow-up if one was queued (e.g. switch_to_plan interrupted)
        if (this.pendingFollowUp) {
          followUpToProcess = this.pendingFollowUp;
          this.pendingFollowUp = null;
          log.info({ workerId: this.id }, "Recovered pending follow-up after error");
        } else {
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
      }

      // If we have a follow-up, resume with it
      if (followUpToProcess && this.sessionId) {
        // Track follow-up context for plan mode batching
        if (this._permissionMode === 'plan') {
          this.followUpQuestion = followUpToProcess;
          this.followUpTimestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        }
        currentPrompt = followUpToProcess;
        resumeId = this.sessionId;
        continue;
      }

      // No follow-up and no session — guard against silent exit
      if (!followUpToProcess) {
        this.setState(WorkerState.Errored);
        return;
      }
    }
  }

  /** Handle worker completion — send result directly to Telegram */
  private async handleCompletion(result: SDKResultMessage): Promise<void> {
    const cost = result.total_cost_usd.toFixed(4);

    this.logEvent("worker_completed", { subtype: result.subtype, cost: result.total_cost_usd, turns: result.num_turns });

    let resultText: string;
    if (result.subtype === "success" && result.result) {
      this.logEvent("formatter_started", { context: "result" });
      resultText = await this.callFormatter({ skill: "format-result", input: { result: result.result }, label: "result" });
      this.logEvent("formatter_done", { context: "result" });
    } else if (result.subtype === "success") {
      // Empty SDK result — load recent assistant messages from DB (same pattern as plan follow-up)
      const messages = getWorkerRecentMessages(this.id, 3);
      const fallback = messages
        .map((m) => {
          const data = typeof m.data === "string" ? JSON.parse(m.data) : m.data;
          return (data as any)?.text || "";
        })
        .filter(Boolean)
        .join("\n\n");
      if (fallback) {
        this.logEvent("formatter_started", { context: "result_fallback" });
        resultText = await this.callFormatter({ skill: "format-result", input: { result: fallback }, label: "result fallback" });
        this.logEvent("formatter_done", { context: "result_fallback" });
      } else {
        resultText = "(no output)";
      }
    } else {
      resultText = `Error: ${result.subtype}`;
    }

    const text = `${this.telegramCtx.emoji} #${this.id} [${this.modeTag}] done — $${cost}\n\n${resultText}`;

    try {
      const resultCtx: SendContext = { source: "worker_result", workerId: this.id };
      await this.telegramCtx.sendLongMessage(this.telegramCtx.chatId, text, resultCtx);
    } catch (err) {
      log.error({ err, workerId: this.id }, "Failed to send completion to Telegram");
    }

  }

  // --- Formatter ---

  private async callFormatter(opts: {
    skill: FormatterSkill;
    input: Record<string, unknown>;
    label: string;
  }): Promise<string> {
    const rawEvents = getEventsSinceLastTask(this.id);
    const events = rawEvents
      .filter(e => FORMATTER_EVENT_TYPES.has(e.type))
      .map(e => ({
        type: e.type,
        data: e.data,
        created_at: e.createdAt,
      }));
    return formatText({
      skill: opts.skill,
      input: { ...opts.input, events },
      label: opts.label,
    });
  }

  async followUp(message: string): Promise<void> {
    if (this.followUpSignal) {
      // Worker is waiting for follow-up, wake it up
      this.followUpSignal.resolve(message);
      this.followUpSignal = null;
      return;
    }
    if (this.query) {
      // Defence in depth: the dispatcher routes follow_up-on-pending-plan to rejectPlan,
      // so this branch shouldn't fire. If something ever reaches here with a pending plan,
      // carry the message as rejection feedback instead of dropping it.
      if (this.planResolver) {
        this.rejectPlan(message);
        log.info({ workerId: this.id }, "Follow-up arrived with pending plan — delivered message as rejection feedback");
        return;
      }
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
  async warmUp(resumeSessionId: string, initialPrompt?: string): Promise<void> {
    if (!this.isCold()) {
      throw new Error(`Worker #${this.id} is already warm`);
    }
    this.sessionId = resumeSessionId;
    await this.start(resumeSessionId, initialPrompt);
  }
}
