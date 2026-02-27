import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type SDKResultMessage } from "@anthropic-ai/claude-code";

import { notifyConcierg } from "../concierg/index.js";
import {
  getActiveWorkers,
  getAllProjects,
  getProjectByName,
  getResumableWorkers,
  getWorkerById,
  getWorkerWithProject,
  hasCompletionEvent,
  insertEvent,
  insertWorker,
  markIntentProcessed,
  markWorkerStopped,
  updateWorkerState,
} from "../db/queries.js";
import { getConfig } from "../config/index.js";
import { WorkerState } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { WorkerLLM, WorkerPool } from "../worker/index.js";
import type { WorkerTelegramContext } from "../worker/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERAL_WORKER_DIR = join(__dirname, "..", "..", "concierg-workspace", "general-worker");

const log = createChildLogger("dispatcher");

function sanitizeResult(text: string): string {
  return text.replace(/\/Users\/[^\s"'<>)}\]]+/g, "[path hidden]");
}

/** Telegram functions injected at startup */
export interface TelegramFunctions {
  sendMessage: (chatId: number, text: string) => Promise<number>;
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
}

/**
 * In-memory map: telegramMsgId → workerId for reply routing.
 * When a worker sends a message to Telegram, we track it here so that
 * when the user replies to that message, we know which worker to route to.
 */
const messageToWorker = new Map<number, number>();

export function getWorkerIdByTelegramMessage(telegramMsgId: number): number | undefined {
  return messageToWorker.get(telegramMsgId);
}

export class Dispatcher {
  private pool: WorkerPool;
  private telegramFns: TelegramFunctions | null = null;

  constructor() {
    this.pool = new WorkerPool();
  }

  setTelegramFunctions(fns: TelegramFunctions): void {
    this.telegramFns = fns;
  }

  getPool(): WorkerPool {
    return this.pool;
  }

  getWorkerOutput(workerId: number): {
    state: string;
    stdout: string;
    stderr: string;
    events: Array<{ timestamp: Date; type: string; content: string }>;
  } | null {
    const session = this.pool.get(workerId);
    if (!session) {
      const worker = getWorkerById(workerId);
      if (!worker) return null;

      return {
        state: worker.state,
        stdout: '',
        stderr: '',
        events: [{ timestamp: new Date(), type: 'info', content: 'Worker not active in pool' }]
      };
    }

    const output = session.getLastOutput();
    return {
      state: session.state,
      stdout: output.stdout,
      stderr: output.stderr,
      events: output.events
    };
  }

  async handleIntent(intent: {
    id: number;
    type: string;
    project: string | null;
    prompt: string;
    userSummary?: string;
    emoji?: string | null;
    planMode?: boolean;
    workerId: number | null;
    questionId: number | null;
    telegramChatId: number;
    telegramMessageId: number;
  }): Promise<void> {
    log.info({ intentId: intent.id, type: intent.type }, "Handling intent");

    markIntentProcessed(intent.id);

    try {
      switch (intent.type) {
        case "spawn_worker":
          await this.spawnWorker(
            intent.project,
            intent.prompt,
            intent.telegramChatId,
            intent.userSummary,
            intent.emoji,
            intent.planMode ?? true,
          );
          break;

        case "follow_up":
          await this.followUp(intent.workerId, intent.prompt, intent.telegramChatId);
          break;

        case "answer_question":
          await this.handleAnswer(
            intent.questionId,
            intent.prompt,
          );
          break;

        case "stop":
          await this.stopWorker(intent.workerId);
          break;

        case "pause":
          await this.pauseWorker(intent.workerId);
          break;

        case "resume":
        case "restore_worker":
          await this.resume(intent.workerId, intent.telegramChatId);
          break;

        case "rewind":
          await this.rewindWorker(intent.workerId, intent.prompt);
          break;

        case "status":
          // Concierg handles status via get_system_state + send_telegram_message
          break;

        case "general":
          break;

        default:
          log.warn({ type: intent.type }, "Unknown intent type");
      }
    } catch (err) {
      log.error({ err, intentId: intent.id }, "Error handling intent");
      notifyConcierg(`[ERROR] Intent processing failed: ${(err as Error).message}`);
    }
  }

  // --- Telegram context factory ---

  private makeTelegramContext(chatId: number, emoji: string): WorkerTelegramContext {
    if (!this.telegramFns) throw new Error("Telegram functions not set");
    return {
      chatId,
      emoji,
      sendMessage: this.telegramFns.sendMessage,
      sendLongMessage: this.telegramFns.sendLongMessage,
      sendQuestionMessage: this.telegramFns.sendQuestionMessage,
      sendPhoto: this.telegramFns.sendPhoto,
      trackMessage: (telegramMsgId, workerId) => {
        messageToWorker.set(telegramMsgId, workerId);
      },
    };
  }

  // --- Spawn ---

  private async spawnWorker(
    projectName: string | null,
    prompt: string,
    chatId: number,
    userSummary?: string,
    emoji?: string | null,
    planMode: boolean = true,
  ): Promise<void> {
    if (!projectName) {
      notifyConcierg("[ERROR] No project specified for spawn");
      return;
    }

    // Resolve project from DB
    let projectPath: string;
    let projectId: number;
    let resolvedProjectName: string;

    if (projectName === "general") {
      const generalProject = getProjectByName("general");
      if (!generalProject) {
        notifyConcierg("[ERROR] General worker project not found in database");
        return;
      }
      projectPath = GENERAL_WORKER_DIR;
      projectId = generalProject.id;
      resolvedProjectName = "general";
    } else {
      const project = getProjectByName(projectName);
      if (!project) {
        const allProjects = getAllProjects();
        const names = allProjects.map((p) => p.name).join(", ");
        notifyConcierg(`[ERROR] Project "${projectName}" not found. Available: ${names || "(none)"}`);
        return;
      }
      projectPath = project.path;
      projectId = project.id;
      resolvedProjectName = project.name;
    }

    const workerRow = insertWorker(projectId, prompt, chatId, emoji);
    const workerEmoji = emoji || "🔵";

    // Enrich prompt with evidence instructions
    const enrichedPrompt = prompt + '\n\n' +
      'When you complete your task, include evidence of success: test results, ' +
      'file contents, or command output that proves the work is done correctly. ' +
      'If you are unsure about anything, use AskUserQuestion to ask. ' +
      'Use the send_telegram_message tool to send progress updates to the user.';

    const telegramCtx = this.makeTelegramContext(chatId, workerEmoji);
    const session = new WorkerLLM(
      workerRow.id,
      projectPath,
      enrichedPrompt,
      telegramCtx,
      planMode ? 'plan' : 'default',
    );

    // Wire completion callback
    session.onCompletion = (_wId, _result) => {
      // Completion is handled inside WorkerLLM.handleCompletion() which sends to Telegram directly
      // This callback is for additional cleanup if needed
    };

    this.pool.add(session);

    // Notify user via Concierg
    notifyConcierg(
      `[SPAWN | Worker #${workerRow.id} | ${workerEmoji} | project: ${resolvedProjectName} | mode: ${planMode ? 'plan' : 'default'}] Task: "${userSummary || prompt}"`
    );

    // Start worker in background
    session.start().catch((err) => {
      log.error({ err, workerId: workerRow.id }, "Worker start failed");
      updateWorkerState(workerRow.id, WorkerState.Errored);
      notifyConcierg(`[ERROR | Worker #${workerRow.id}] Failed to start: ${(err as Error).message}`);
      this.removeWorkerFromPool(workerRow.id);
    });
  }

  // --- Answer handling ---

  private async handleAnswer(
    questionId: number | null,
    answer: string,
  ): Promise<void> {
    if (questionId) {
      // Find the worker that owns this question and resolve it
      for (const session of this.pool.getAll()) {
        if (session.hasQuestion(questionId)) {
          session.resolveQuestion(questionId, answer);
          return;
        }
      }
      log.warn({ questionId }, "No worker found with this question");
      notifyConcierg("[ERROR] No worker found with this pending question.");
      return;
    }

    // Try to find a single worker with pending questions
    const workersWithQuestions = this.pool.getAll().filter(
      (w) => w.state === WorkerState.WaitingInput
    );

    if (workersWithQuestions.length === 1) {
      // Auto-route to the only waiting worker — but we don't know the questionId
      notifyConcierg("[ERROR] Please reply to the specific question message or tap a button.");
    } else if (workersWithQuestions.length > 1) {
      notifyConcierg("[ERROR] Multiple workers waiting. Reply to the specific question.");
    } else {
      notifyConcierg("[ERROR] No pending questions to answer.");
    }
  }

  /** Resolve a question by ID — called from callback handler */
  resolveQuestion(questionId: number, answer: string): boolean {
    for (const session of this.pool.getAll()) {
      if (session.resolveQuestion(questionId, answer)) {
        return true;
      }
    }
    log.warn({ questionId }, "No resolver found for question");
    return false;
  }

  /** Resolve a plan review for a worker — called from callback handler */
  resolvePlan(workerId: number, decision: string): boolean {
    const session = this.pool.get(workerId);
    if (session) {
      return session.resolvePlan(decision);
    }
    log.warn({ workerId }, "No worker found for plan resolution");
    return false;
  }

  // --- Follow-up ---

  private async followUp(
    workerId: number | null,
    message: string,
    chatId: number
  ): Promise<void> {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        notifyConcierg("[ERROR] Multiple workers active. Specify which one.");
        return;
      }
    }

    const session = this.pool.get(targetId);
    if (!session) {
      notifyConcierg(`[ERROR | Worker #${targetId}] Worker not found or not running.`);
      return;
    }

    // Cold worker — warm it up with the follow-up as prompt
    if (session.isCold()) {
      const worker = getWorkerById(targetId);
      if (worker?.sessionId) {
        log.info({ workerId: targetId }, "Warming up cold worker via follow-up");
        notifyConcierg(`[SYSTEM | Worker #${targetId}] Resuming cold worker...`);
        session.warmUp(worker.sessionId).catch((err) => {
          log.error({ err, workerId: targetId }, "Cold worker warm-up failed");
          updateWorkerState(targetId!, WorkerState.Errored);
          notifyConcierg(`[ERROR | Worker #${targetId}] Resume failed: ${(err as Error).message}`);
          this.removeWorkerFromPool(targetId!);
        });
        return;
      }
    }

    // Direct follow-up to worker
    try {
      await session.followUp(message);
    } catch (err) {
      log.error({ err, workerId: targetId }, "Failed to send follow-up");
      notifyConcierg(`[ERROR | Worker #${targetId}] Worker not found or not running.`);
    }
  }

  // --- Stop / Pause / Resume ---

  private async stopWorker(
    workerId: number | null,
  ): Promise<void> {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        notifyConcierg("[ERROR] Specify which worker to stop.");
        return;
      }
    }

    const session = this.pool.get(targetId);
    if (session) {
      session.abort();
      this.cleanupWorker(targetId);
      notifyConcierg(`[STOPPED | Worker #${targetId}]`);
    } else {
      markWorkerStopped(targetId);
      notifyConcierg(`[STOPPED | Worker #${targetId}] Marked stopped in DB.`);
    }
  }

  private async pauseWorker(
    workerId: number | null,
  ): Promise<void> {
    if (!workerId) {
      notifyConcierg("[ERROR] Specify which worker to pause.");
      return;
    }

    const session = this.pool.get(workerId);
    if (!session) {
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker not found.`);
      return;
    }

    if (session.state === WorkerState.WaitingInput) {
      log.warn({ workerId }, "Cannot pause worker in WaitingInput state");
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker is waiting for input — can't be paused. Answer the pending question or stop it.`);
      return;
    }

    await session.interrupt();
    notifyConcierg(`[PAUSED | Worker #${workerId}]`);
  }

  /**
   * Rewind a worker: switch back to planning mode and send a follow-up.
   * The mode change takes effect on the next query (after interrupt + follow-up).
   */
  private async rewindWorker(
    workerId: number | null,
    reason: string,
  ): Promise<void> {
    if (!workerId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        workerId = active[0].id;
      } else {
        notifyConcierg("[ERROR] Specify which worker to rewind.");
        return;
      }
    }

    const session = this.pool.get(workerId);
    if (!session) {
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker not found.`);
      return;
    }

    const wasPlanning = session.permissionMode === 'plan';

    if (wasPlanning && !session.phase) {
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker is already in planning mode.`);
      return;
    }

    // Switch mode — takes effect on next query
    session.switchToPlanning();

    // Send follow-up to interrupt current work and re-enter planning
    const followUpMessage = reason
      ? `STOP current work. User wants to go back to planning mode. Reason: ${reason}\n\nRe-evaluate your approach. Create a new plan based on the user's feedback. Use ExitPlanMode when your plan is ready.`
      : `STOP current work. User wants to go back to planning mode.\n\nRe-evaluate your approach and create a new plan. Use ExitPlanMode when your plan is ready.`;

    try {
      await session.followUp(followUpMessage);
      notifyConcierg(`[REWIND | Worker #${workerId}] Switched back to planning mode.`);
    } catch (err) {
      log.error({ err, workerId }, "Failed to rewind worker");
      notifyConcierg(`[ERROR | Worker #${workerId}] Failed to rewind: ${(err as Error).message}`);
    }
  }

  async resume(
    workerId: number | null,
    chatId: number
  ): Promise<{ success: boolean; reason?: string }> {
    if (!workerId) {
      notifyConcierg("[ERROR] Specify which worker to resume.");
      return { success: false, reason: "no_worker_id" };
    }

    // Already in pool and running — send follow-up instead of duplicating
    const existingSession = this.pool.get(workerId);
    if (existingSession && !existingSession.isCold()) {
      const workerData = getWorkerWithProject(workerId);
      const taskContext = workerData?.worker.currentPrompt || "your previous task";
      await this.followUp(workerId, `Continue working. Your task was: "${taskContext}"`, chatId);
      return { success: true };
    }

    // In pool but cold — warm it up
    if (existingSession && existingSession.isCold()) {
      const worker = getWorkerById(workerId);
      if (worker?.sessionId) {
        notifyConcierg(`[RESUMING | Worker #${workerId}]`);
        existingSession.warmUp(worker.sessionId).catch((err) => {
          log.error({ err, workerId }, "Resume (warm-up) failed");
          updateWorkerState(workerId, WorkerState.Errored);
          notifyConcierg(`[ERROR | Worker #${workerId}] Resume failed: ${(err as Error).message}`);
          this.removeWorkerFromPool(workerId);
        });
        return { success: true };
      }
    }

    // Not in pool — load from DB
    const workerData = getWorkerWithProject(workerId);
    if (!workerData) {
      notifyConcierg(`[ERROR | Worker #${workerId}] Worker not found.`);
      return { success: false, reason: "not_found" };
    }

    const { worker, project } = workerData;

    if (!worker.sessionId) {
      return { success: false, reason: "no_session" };
    }

    const telegramCtx = this.makeTelegramContext(chatId, worker.emoji || "🔵");
    const session = new WorkerLLM(worker.id, project.path, worker.currentPrompt, telegramCtx);

    this.pool.add(session);

    notifyConcierg(
      `[RESUMING | Worker #${workerId} | project: ${project.name}] Task: "${worker.currentPrompt}"`
    );

    session.start(worker.sessionId).catch((err) => {
      log.error({ err, workerId }, "Resume failed");
      updateWorkerState(worker.id, WorkerState.Errored);
      notifyConcierg(`[ERROR | Worker #${workerId}] Resume failed: ${(err as Error).message}`);
      this.removeWorkerFromPool(workerId);
    });

    return { success: true };
  }

  // --- Idle ---

  async handleIdleWorker(workerId: number): Promise<void> {
    notifyConcierg(`[IDLE | Worker #${workerId}] Worker seems idle.`);
    insertEvent(workerId, "idle_alert", {});
  }

  // --- Cleanup ---

  private removeWorkerFromPool(workerId: number): void {
    const session = this.pool.get(workerId);
    if (session) session.abort();
    this.pool.remove(workerId);
  }

  cleanupWorker(workerId: number): void {
    this.removeWorkerFromPool(workerId);
    markWorkerStopped(workerId);
    insertEvent(workerId, "removed", { reason: "cleanup" });
  }

  async stopAll(): Promise<void> {
    for (const session of this.pool.getAll()) {
      markWorkerStopped(session.id);
      insertEvent(session.id, "removed", { reason: "shutdown" });
    }
    await this.pool.stopAll();
  }

  // --- Cold Resume from DB ---

  async coldResumeWorkersFromDb(): Promise<void> {
    const MAX_COLD_REGISTRATIONS = 10;
    const { WORKER_RESUME_MAX_AGE_S } = getConfig();

    // Mark all stale active workers as stopped
    const allActive = getActiveWorkers();
    const resumable = getResumableWorkers(WORKER_RESUME_MAX_AGE_S);
    const resumableIds = new Set(resumable.map(w => w.id));

    for (const worker of allActive) {
      if (!resumableIds.has(worker.id)) {
        log.info({ workerId: worker.id, lastActivity: worker.lastActivityAt }, "Marking stale worker as stopped");
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "stale" });
      }
    }

    // Filter resumable workers
    const toColdRegister: typeof resumable = [];
    for (const worker of resumable) {
      if (!worker.sessionId) {
        log.info({ workerId: worker.id }, "Skipping resume — no session ID");
        updateWorkerState(worker.id, WorkerState.Errored);
        insertEvent(worker.id, "skipped_resume", { reason: "no_session_id" });
        continue;
      }

      if (hasCompletionEvent(worker.id)) {
        log.info({ workerId: worker.id }, "Skipping resume — worker already completed");
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "already_completed" });
        continue;
      }

      toColdRegister.push(worker);
    }

    // Cap registrations
    if (toColdRegister.length > MAX_COLD_REGISTRATIONS) {
      log.warn({ total: toColdRegister.length, cap: MAX_COLD_REGISTRATIONS }, "Too many workers to cold-register, capping");
      const skipped = toColdRegister.slice(MAX_COLD_REGISTRATIONS);
      for (const worker of skipped) {
        markWorkerStopped(worker.id);
        insertEvent(worker.id, "skipped_resume", { reason: "resume_cap_exceeded" });
      }
      toColdRegister.length = MAX_COLD_REGISTRATIONS;
    }

    // Cold-register: add to pool without starting SDK sessions
    for (const worker of toColdRegister) {
      const workerData = getWorkerWithProject(worker.id);
      if (!workerData) continue;

      log.info(
        { workerId: worker.id, sessionId: worker.sessionId },
        "Cold-registering worker from DB"
      );

      const telegramCtx = this.makeTelegramContext(worker.telegramChatId, worker.emoji || "🔵");
      const session = new WorkerLLM(worker.id, workerData.project.path, worker.currentPrompt, telegramCtx);
      this.pool.add(session);
      // Note: session.start() is NOT called — worker is cold
    }

    log.info(
      { coldRegistered: toColdRegister.length, staleMarked: allActive.length - resumable.length },
      "Cold resume complete"
    );
  }
}
