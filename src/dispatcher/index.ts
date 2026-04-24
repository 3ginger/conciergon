import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getActiveWorkers,
  getAllProjects,
  getProjectByName,
  getResumableWorkers,
  getWorkerById,
  getWorkerWithProject,
  hasCompletionEvent,
  insertWorker,
  markIntentProcessed,
  markWorkerStopped,
  updateWorkerState,
} from "../db/queries.js";
import {
  insertEvent,
  updateMessageWorkerId,
} from "../db/message-log.js";
import { getConfig } from "../config/index.js";
import { WorkerState } from "../types/index.js";
import { createChildLogger } from "../utils/logger.js";
import { WorkerLLM, WorkerPool } from "../worker/index.js";
import type { WorkerTelegramContext } from "../worker/session.js";
import type { SendContext } from "../telegram/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERAL_WORKER_DIR = join(__dirname, "..", "..", "concierg-workspace", "general-worker");

const log = createChildLogger("dispatcher");

/** Telegram functions injected at startup */
export interface TelegramFunctions {
  sendMessage: (chatId: number, text: string, context?: SendContext) => Promise<number>;
  sendLongMessage: (chatId: number, text: string, context?: SendContext) => Promise<number[]>;
  sendQuestionMessage: (
    chatId: number,
    workerId: number,
    question: string,
    emoji?: string,
    mode?: string,
  ) => Promise<number>;
  sendDocument: (chatId: number, filePath: string, caption?: string, context?: SendContext) => Promise<number>;
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

  async handleIntent(intent: {
    id: number;
    type: string;
    workerId: number | null;
    telegramMessageId: number;
    messageRowId: number;
    data: Record<string, unknown>;
  }): Promise<void> {
    log.info({ intentId: intent.id, type: intent.type }, "Handling intent");

    markIntentProcessed(intent.id);

    const d = intent.data;
    const logWorkerEvent = (workerId: number | null, eventType: import("../types/index.js").EventType, eventData?: Record<string, unknown>) => {
      if (!workerId) return;
      insertEvent({ workerId, type: eventType, data: eventData, messageId: intent.messageRowId });
      updateMessageWorkerId(intent.messageRowId, workerId);
    };

    try {
      switch (intent.type) {
        case "spawn_worker": {
          await this.spawnWorker({
            project: d.project as string,
            prompt: d.prompt as string,
            emoji: d.emoji as string,
            planMode: !d.scheduledExec,
            messageRowId: intent.messageRowId,
          });
          break;
        }

        case "follow_up": {
          const prompt = d.prompt as string;
          logWorkerEvent(intent.workerId, "follow_up", { prompt });
          await this.followUp(intent.workerId, prompt);
          break;
        }

        case "approve_plan": {
          const prompt = d.prompt as string;
          logWorkerEvent(intent.workerId, "plan_approved", { prompt });
          await this.approvePlan(intent.workerId, prompt);
          break;
        }

        case "reject_plan": {
          const prompt = d.prompt as string;
          logWorkerEvent(intent.workerId, "plan_rejected", { prompt });
          await this.rejectPlan(intent.workerId, prompt);
          break;
        }

        case "answer_question": {
          const answer = d.answer as string;
          logWorkerEvent(intent.workerId, "question_answered", { answer });
          await this.handleAnswer(intent.workerId, answer);
          break;
        }

        case "terminate":
          logWorkerEvent(intent.workerId, "worker_terminated");
          await this.stopWorker(intent.workerId);
          break;

        case "pause":
          logWorkerEvent(intent.workerId, "worker_paused");
          await this.pauseWorker(intent.workerId);
          break;

        case "resume": {
          const prompt = d.prompt as string;
          logWorkerEvent(intent.workerId, "worker_resumed", { prompt });
          const resolved = this.resolveSession(intent.workerId, "resume");
          if (resolved && resolved.session.isCold()) {
            await this.deliverPrompt(resolved.session, resolved.id, prompt);
          }
          break;
        }

        case "switch_to_plan": {
          const prompt = d.prompt as string;
          logWorkerEvent(intent.workerId, "mode_switch", { to: "plan", prompt });
          await this.switchToPlan(intent.workerId, prompt);
          break;
        }

        default:
          log.warn({ type: intent.type }, "Unknown intent type");
      }
    } catch (err) {
      log.error({ err, intentId: intent.id }, "Error handling intent");
    }
  }

  // --- Telegram context factory ---

  private makeTelegramContext(chatId: number, emoji: string, workerId: number): WorkerTelegramContext {
    if (!this.telegramFns) throw new Error("Telegram functions not set");
    const workerCtx: SendContext = { source: "worker_progress", workerId };
    return {
      chatId,
      emoji,
      workerId,
      sendMessage: (cId, text) => this.telegramFns!.sendMessage(cId, text, workerCtx),
      sendLongMessage: (cId, text, ctxOverride?) => this.telegramFns!.sendLongMessage(cId, text, ctxOverride ?? workerCtx),
      sendQuestionMessage: this.telegramFns!.sendQuestionMessage,
      sendDocument: (cId, filePath, caption?, ctxOverride?) => this.telegramFns!.sendDocument(cId, filePath, caption, ctxOverride ?? workerCtx),
    };
  }

  // --- Spawn ---

  private async spawnWorker(opts: {
    project: string;
    prompt: string;
    emoji?: string | null;
    planMode?: boolean;
    messageRowId?: number;
  }): Promise<void> {
    const { project: projectName, prompt, emoji, planMode = true, messageRowId } = opts;
    const chatId = getConfig().TELEGRAM_ALLOWED_USERS[0];

    if (!projectName) {
      log.error("No project specified for spawn");
      return;
    }

    // Resolve project from DB
    let projectPath: string;
    let projectId: number;
    let resolvedProjectName: string;

    if (projectName === "general") {
      const generalProject = getProjectByName("general");
      if (!generalProject) {
        log.error("General worker project not found in database");
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
        log.error({ projectName, available: names }, "Project not found");
        return;
      }
      projectPath = project.path;
      projectId = project.id;
      resolvedProjectName = project.name;
    }

    const workerRow = insertWorker(projectId, emoji);
    const workerEmoji = emoji || "🔵";

    if (messageRowId) {
      updateMessageWorkerId(messageRowId, workerRow.id);
    }

    insertEvent({
      workerId: workerRow.id,
      type: "worker_spawning",
      data: { prompt, project: resolvedProjectName, planMode },
      messageId: messageRowId ?? null,
    });

    const telegramCtx = this.makeTelegramContext(chatId, workerEmoji, workerRow.id);
    const session = new WorkerLLM(
      workerRow.id,
      projectPath,
      prompt,
      telegramCtx,
      planMode ? 'plan' : 'default',
    );

    this.pool.add(session);

    session.start().catch((err) => {
      log.error({ err, workerId: workerRow.id }, "Worker start failed");
      updateWorkerState(workerRow.id, WorkerState.Errored);
      this.removeWorkerFromPool(workerRow.id);
    });
  }

  // --- Answer handling ---

  private async handleAnswer(
    workerId: number | null,
    answer: string,
  ): Promise<void> {
    if (!workerId) {
      log.error("answer_question requires workerId");
      return;
    }

    const session = this.pool.get(workerId);
    if (!session) {
      log.error({ workerId }, "Worker not found in pool");
      return;
    }

    if (!session.resolveQuestion(answer)) {
      log.warn({ workerId }, "No pending question to answer");
    }
  }

  // --- Session creation from DB ---

  /** Load worker from DB, create cold WorkerLLM, add to pool. Returns null if not found/no sessionId. */
  private createSessionFromDb(workerId: number): WorkerLLM | null {
    const workerData = getWorkerWithProject(workerId);
    if (!workerData?.worker.sessionId) return null;

    const { worker, project } = workerData;
    log.info({ workerId }, "Creating session from DB");
    const chatId = getConfig().TELEGRAM_ALLOWED_USERS[0];
    const telegramCtx = this.makeTelegramContext(chatId, worker.emoji || "🔵", worker.id);
    const restoredMode = (worker.permissionMode as 'plan' | 'default') || 'plan';
    const session = new WorkerLLM(worker.id, project.path, "", telegramCtx, restoredMode);
    session.restorePlanState(restoredMode);
    this.pool.add(session);
    return session;
  }

  // --- Worker session resolver (single path for all intents) ---

  /**
   * Resolve the worker and return its session from the pool (creating a cold one from
   * DB if needed). Does NOT warm up cold sessions — callers mutate session state first
   * (e.g. switchToExecution) and then hand off to deliverPrompt.
   */
  private resolveSession(
    workerId: number | null,
    errorContext: string,
  ): { session: WorkerLLM; id: number } | null {
    let targetId = workerId;
    if (!targetId) {
      const active = getActiveWorkers();
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        log.error({ errorContext }, "Ambiguous worker: specify which worker");
        return null;
      }
    }

    let session: WorkerLLM | undefined = this.pool.get(targetId);
    if (!session) {
      session = this.createSessionFromDb(targetId) ?? undefined;
      if (!session) {
        log.error({ workerId: targetId }, "Worker not found or not running");
        return null;
      }
    }
    return { session, id: targetId };
  }

  /**
   * Deliver a prompt to a resolved session: warm up the SDK with it as the initial
   * resume prompt when cold, otherwise interrupt + follow-up. Called AFTER any mode
   * mutations so the SDK picks up the updated permissionMode on start.
   */
  private async deliverPrompt(
    session: WorkerLLM,
    id: number,
    prompt: string,
  ): Promise<void> {
    if (session.isCold()) {
      const worker = getWorkerById(id);
      if (!worker?.sessionId) {
        log.error({ workerId: id }, "Worker has no session to resume");
        return;
      }
      log.info({ workerId: id }, "Resuming worker");
      session.warmUp(worker.sessionId, prompt)
        .catch((err) => {
          log.error({ err, workerId: id }, "Worker warm-up failed");
          updateWorkerState(id, WorkerState.Errored);
          this.removeWorkerFromPool(id);
        });
      return;
    }

    try {
      await session.followUp(prompt);
    } catch (err) {
      log.error({ err, workerId: id }, "Failed to deliver prompt");
    }
  }

  // --- Follow-up ---

  private async followUp(workerId: number | null, message: string): Promise<void> {
    const resolved = this.resolveSession(workerId, "follow_up");
    if (!resolved) return;
    const { session, id } = resolved;

    if (session.hasPendingPlan()) {
      log.info({ workerId: id }, "Follow-up on pending plan — routing as reject_plan");
      session.rejectPlan(message);
      return;
    }

    await this.deliverPrompt(session, id, message);
  }

  // --- Plan approval / rejection ---

  private async approvePlan(workerId: number | null, prompt: string): Promise<void> {
    const resolved = this.resolveSession(workerId, "approve_plan");
    if (!resolved) return;
    const { session, id } = resolved;

    if (session.hasPendingPlan()) {
      // Warm session awaiting ExitPlanMode — let the canUseTool handler flip the mode.
      session.approvePlan();
    } else if (session.permissionMode === 'plan') {
      // Cold session (or warm with no pending plan) still in plan mode — flip explicitly
      // so the next SDK start picks up permissionMode='default' and the DB reflects reality.
      session.switchToExecution();
    } else {
      log.warn({ workerId: id }, "No pending plan to approve");
      return;
    }

    await this.deliverPrompt(session, id, prompt);
  }

  private async rejectPlan(workerId: number | null, prompt: string): Promise<void> {
    const resolved = this.resolveSession(workerId, "reject_plan");
    if (!resolved) return;
    const { session, id } = resolved;

    if (session.hasPendingPlan()) {
      session.rejectPlan(prompt);
      return;
    }

    // Cold session: no in-memory planResolver, but the worker was stopped mid-plan.
    // Deliver the rejection as the resume prompt so the model revises.
    if (session.isCold() && session.permissionMode === 'plan') {
      await this.deliverPrompt(session, id, prompt);
      return;
    }

    log.warn({ workerId: id }, "No pending plan to reject");
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
        log.error("Specify which worker to stop");
        return;
      }
    }

    const session = this.pool.get(targetId);
    if (session) {
      session.abort();
      this.cleanupWorker(targetId);
    } else {
      markWorkerStopped(targetId);
    }
    log.info({ workerId: targetId }, "Worker stopped");
  }

  private async pauseWorker(
    workerId: number | null,
  ): Promise<void> {
    if (!workerId) {
      log.error("Specify which worker to pause");
      return;
    }

    const session = this.pool.get(workerId);
    if (!session) {
      log.error({ workerId }, "Worker not found");
      return;
    }

    if (session.state === WorkerState.WaitingInput) {
      log.warn({ workerId }, "Cannot pause worker in WaitingInput state");
      return;
    }

    await session.interrupt();
    log.info({ workerId }, "Worker paused");
  }

  private async switchToPlan(workerId: number | null, prompt: string): Promise<void> {
    const resolved = this.resolveSession(workerId, "switch_to_plan");
    if (!resolved) return;
    const { session, id } = resolved;

    if (session.phase === 'planning') {
      log.warn({ workerId: id }, "Worker already in planning mode");
      return;
    }

    session.switchToPlanning();
    await this.deliverPrompt(session, id, prompt);
    log.info({ workerId: id }, "Switched back to planning mode");
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
    insertEvent({ workerId, type: "worker_stopped", data: { reason: "cleanup" } });
  }

  async stopAll(): Promise<void> {
    for (const session of this.pool.getAll()) {
      markWorkerStopped(session.id);
      insertEvent({ workerId: session.id, type: "worker_stopped", data: { reason: "shutdown" } });
    }
    await this.pool.stopAll();
  }

  // --- Startup cleanup ---

  /** Mark stale/completed workers as stopped. Workers are loaded from DB on demand by resolveSession. */
  async cleanupStaleWorkers(): Promise<void> {
    const { WORKER_RESUME_MAX_AGE_S } = getConfig();
    const allActive = getActiveWorkers();
    const resumable = getResumableWorkers(WORKER_RESUME_MAX_AGE_S);
    const resumableIds = new Set(resumable.map(w => w.id));

    for (const worker of allActive) {
      if (!resumableIds.has(worker.id)) {
        log.info({ workerId: worker.id, lastActivity: worker.lastActivityAt }, "Marking stale worker as stopped");
        markWorkerStopped(worker.id);
        insertEvent({ workerId: worker.id, type: "worker_stopped", data: { reason: "stale" } });
      }
    }

    for (const worker of resumable) {
      if (!worker.sessionId) {
        updateWorkerState(worker.id, WorkerState.Errored);
        insertEvent({ workerId: worker.id, type: "worker_error", data: { reason: "no_session_id" } });
      } else if (hasCompletionEvent(worker.id)) {
        markWorkerStopped(worker.id);
        insertEvent({ workerId: worker.id, type: "worker_stopped", data: { reason: "already_completed" } });
      }
    }

    log.info({ staleMarked: allActive.length - resumable.length }, "Startup cleanup complete");
  }
}
