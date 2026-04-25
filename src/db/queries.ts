import { eq, and, sql, desc } from "drizzle-orm";
import { getDb, schema } from "./index.js";
import type { ClassifiedIntent } from "../types/index.js";
import { INTENT_TYPES, WorkerState } from "../types/index.js";

const INTENT_TYPE_SET = new Set<string>(INTENT_TYPES);

// --- Projects ---

export function upsertProject(name: string, path: string) {
  const db = getDb();
  return db
    .insert(schema.projects)
    .values({ name, path })
    .onConflictDoUpdate({ target: schema.projects.path, set: { name } })
    .returning()
    .get();
}

export function getAllProjects() {
  return getDb().select().from(schema.projects).all();
}

export function getProjectByName(name: string) {
  return getDb()
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, name))
    .get();
}

// --- Intents ---

export function insertIntent(intent: ClassifiedIntent) {
  if (!INTENT_TYPE_SET.has(intent.type)) {
    throw new Error(`Invalid intent type: "${intent.type}". Valid: ${INTENT_TYPES.join(", ")}`);
  }
  const d = intent.data as Record<string, unknown>;
  switch (intent.type) {
    case "spawn_worker":
      if (!d.project || !d.prompt || !d.emoji) throw new Error("spawn_worker requires project, prompt, emoji");
      break;
    case "follow_up":
    case "reject_plan":
    case "switch_to_plan":
      if (!d.prompt && intent.type === "follow_up") throw new Error("follow_up requires prompt");
      break;
    case "answer_question":
      break;
  }

  return getDb()
    .insert(schema.intents)
    .values({
      type: intent.type,
      telegramMessageId: intent.telegramMessageId,
      workerId: intent.workerId,
      data: intent.data,
    })
    .returning()
    .get();
}

export function getUnprocessedIntents() {
  return getDb()
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.processed, false))
    .orderBy(schema.intents.id)
    .all();
}

export function markIntentProcessed(id: number) {
  return getDb()
    .update(schema.intents)
    .set({ processed: true })
    .where(eq(schema.intents.id, id))
    .run();
}

// --- Workers ---

export function insertWorker(
  projectId: number,
  emoji?: string | null
) {
  return getDb()
    .insert(schema.workers)
    .values({ projectId, ...(emoji ? { emoji } : {}) })
    .returning()
    .get();
}

export function updateWorkerState(id: number, state: WorkerState) {
  return getDb()
    .update(schema.workers)
    .set({ state, lastActivityAt: sql`datetime('now')` })
    .where(eq(schema.workers.id, id))
    .run();
}

export function updateWorkerSessionId(id: number, sessionId: string) {
  return getDb()
    .update(schema.workers)
    .set({ sessionId })
    .where(eq(schema.workers.id, id))
    .run();
}

export function updateWorkerPermissionMode(id: number, mode: 'plan' | 'default') {
  return getDb()
    .update(schema.workers)
    .set({ permissionMode: mode })
    .where(eq(schema.workers.id, id))
    .run();
}

export function touchWorkerActivity(id: number) {
  return getDb()
    .update(schema.workers)
    .set({ lastActivityAt: sql`datetime('now')` })
    .where(eq(schema.workers.id, id))
    .run();
}

export function getActiveWorkers() {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      sql`${schema.workers.state} IN ('starting', 'active', 'waiting_input')`
    )
    .all();
}

export function getWorkerById(id: number) {
  return getDb()
    .select()
    .from(schema.workers)
    .where(eq(schema.workers.id, id))
    .get();
}

export function getWorkerWithProject(id: number) {
  return getDb()
    .select({
      worker: schema.workers,
      project: schema.projects,
    })
    .from(schema.workers)
    .innerJoin(schema.projects, eq(schema.workers.projectId, schema.projects.id))
    .where(eq(schema.workers.id, id))
    .get();
}

export function getIdleWorkers(timeoutSeconds: number) {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      and(
        eq(schema.workers.state, "active"),
        sql`datetime(${schema.workers.lastActivityAt}, '+' || ${timeoutSeconds} || ' seconds') < datetime('now')`
      )
    )
    .all();
}

/** Mark a worker as "stopped" in DB (audit-only value, not in WorkerState enum). */
export function markWorkerStopped(id: number) {
  return getDb()
    .update(schema.workers)
    .set({ state: "stopped", lastActivityAt: sql`datetime('now')` })
    .where(eq(schema.workers.id, id))
    .run();
}

/** Get resumable workers: active states within age threshold, ordered by most recently active. */
export function getResumableWorkers(maxAgeSec: number) {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      and(
        sql`${schema.workers.state} IN ('active', 'waiting_input')`,
        sql`datetime(${schema.workers.lastActivityAt}, '+' || ${maxAgeSec} || ' seconds') >= datetime('now')`
      )
    )
    .orderBy(desc(schema.workers.lastActivityAt))
    .all();
}

/** Check if a worker has any completion event (result_delivered or worker_completed). */
export function hasCompletionEvent(workerId: number): boolean {
  const row = getDb()
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        sql`${schema.events.type} IN ('result_delivered', 'worker_completed')`
      )
    )
    .limit(1)
    .get();
  return !!row;
}

// --- Worker messages (assistant text from DB) ---

export function getWorkerRecentMessages(workerId: number, limit: number = 5) {
  return getDb()
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        eq(schema.events.type, "assistant_message")
      )
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(limit)
    .all();
}

export function getWorkerMessagesSince(workerId: number, sinceIso: string) {
  return getDb()
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        eq(schema.events.type, "assistant_message"),
        sql`${schema.events.createdAt} >= ${sinceIso}`
      )
    )
    .orderBy(schema.events.createdAt)
    .all();
}

// --- Recoverable workers (stopped/errored but have sessionId, could be resumed) ---

export function getRecoverableWorkers() {
  return getDb()
    .select()
    .from(schema.workers)
    .where(
      and(
        sql`${schema.workers.state} IN ('stopped', 'errored')`,
        sql`${schema.workers.sessionId} IS NOT NULL AND ${schema.workers.sessionId} != ''`
      )
    )
    .orderBy(desc(schema.workers.lastActivityAt))
    .limit(20)
    .all();
}

// --- Scheduled Tasks ---

export function insertScheduledTask(task: {
  projectId: number;
  cronExpression: string;
  timezone: string;
  prompt: string;
  userSummary: string;
  emoji?: string;
  telegramChatId: number;
  runOnce?: boolean;
}) {
  return getDb()
    .insert(schema.scheduledTasks)
    .values({
      projectId: task.projectId,
      cronExpression: task.cronExpression,
      timezone: task.timezone,
      prompt: task.prompt,
      userSummary: task.userSummary,
      emoji: task.emoji,
      telegramChatId: task.telegramChatId,
      runOnce: task.runOnce ?? false,
    })
    .returning()
    .get();
}

export function getAllScheduledTasks(chatId?: number) {
  const db = getDb();
  if (chatId) {
    return db
      .select({ schedule: schema.scheduledTasks, project: schema.projects })
      .from(schema.scheduledTasks)
      .innerJoin(schema.projects, eq(schema.scheduledTasks.projectId, schema.projects.id))
      .where(eq(schema.scheduledTasks.telegramChatId, chatId))
      .orderBy(schema.scheduledTasks.id)
      .all();
  }
  return db
    .select({ schedule: schema.scheduledTasks, project: schema.projects })
    .from(schema.scheduledTasks)
    .innerJoin(schema.projects, eq(schema.scheduledTasks.projectId, schema.projects.id))
    .orderBy(schema.scheduledTasks.id)
    .all();
}

export function getEnabledScheduledTasks() {
  return getDb()
    .select({ schedule: schema.scheduledTasks, project: schema.projects })
    .from(schema.scheduledTasks)
    .innerJoin(schema.projects, eq(schema.scheduledTasks.projectId, schema.projects.id))
    .where(eq(schema.scheduledTasks.enabled, true))
    .all();
}

export function getScheduledTaskById(id: number) {
  return getDb()
    .select({ schedule: schema.scheduledTasks, project: schema.projects })
    .from(schema.scheduledTasks)
    .innerJoin(schema.projects, eq(schema.scheduledTasks.projectId, schema.projects.id))
    .where(eq(schema.scheduledTasks.id, id))
    .get();
}

export function deleteScheduledTask(id: number) {
  return getDb()
    .delete(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

export function updateScheduledTaskEnabled(id: number, enabled: boolean) {
  return getDb()
    .update(schema.scheduledTasks)
    .set({ enabled })
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

export function updateScheduledTaskLastRun(id: number) {
  return getDb()
    .update(schema.scheduledTasks)
    .set({ lastRunAt: sql`datetime('now')` })
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

export function incrementScheduleErrorCount(id: number) {
  const db = getDb();
  db.update(schema.scheduledTasks)
    .set({ errorCount: sql`${schema.scheduledTasks.errorCount} + 1` })
    .where(eq(schema.scheduledTasks.id, id))
    .run();
  return db
    .select()
    .from(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.id, id))
    .get();
}

export function resetScheduleErrorCount(id: number) {
  return getDb()
    .update(schema.scheduledTasks)
    .set({ errorCount: 0 })
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

// --- Message Payload (for skill pre-baking) ---

interface MessagePayloadReplyTo {
  id: number;
  direction: string;
  source: string;
  text: string | null;
  worker_id: number | null;
}

interface MessagePayload {
  id: number;
  chat_id: number;
  text: string | null;
  image_paths: string[];
  reply_to: MessagePayloadReplyTo | null;
  recent_chat: Array<{
    direction: string;
    source: string;
    text: string | null;
    worker_id: number | null;
  }>;
  recent_worker_events: Array<{
    type: string;
    data: unknown;
    created_at: string;
  }>;
}

function fetchMessageRow(id: number) {
  return getDb()
    .select()
    .from(schema.telegramMessages)
    .where(eq(schema.telegramMessages.id, id))
    .get();
}

function fetchMessageByTelegramId(telegramMessageId: number, chatId: number) {
  return getDb()
    .select()
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramMessageId, telegramMessageId),
        eq(schema.telegramMessages.telegramChatId, chatId),
      ),
    )
    .orderBy(desc(schema.telegramMessages.id))
    .limit(1)
    .get();
}

export function loadMessagePayload(messageRowId: number): MessagePayload | null {
  const row = fetchMessageRow(messageRowId);
  if (!row) return null;

  const imagePaths: string[] = row.imagePaths
    ? (typeof row.imagePaths === "string" ? JSON.parse(row.imagePaths) : row.imagePaths) as string[]
    : [];

  let replyTo: MessagePayloadReplyTo | null = null;
  if (row.replyToTelegramMessageId) {
    const replyRow = fetchMessageByTelegramId(row.replyToTelegramMessageId, row.telegramChatId);
    if (replyRow) {
      replyTo = {
        id: replyRow.id,
        direction: replyRow.direction,
        source: replyRow.source,
        text: replyRow.text,
        worker_id: replyRow.workerId,
      };
    }
  }

  const recentMessages = getDb()
    .select({
      direction: schema.telegramMessages.direction,
      source: schema.telegramMessages.source,
      text: schema.telegramMessages.text,
      workerId: schema.telegramMessages.workerId,
    })
    .from(schema.telegramMessages)
    .where(eq(schema.telegramMessages.telegramChatId, row.telegramChatId))
    .orderBy(desc(schema.telegramMessages.id))
    .limit(8)
    .all()
    .reverse();

  let recentEvents: Array<{ type: string; data: unknown; created_at: string }> = [];
  if (row.workerId) {
    recentEvents = getDb()
      .select({
        type: schema.events.type,
        data: schema.events.data,
        created_at: schema.events.createdAt,
      })
      .from(schema.events)
      .where(eq(schema.events.workerId, row.workerId))
      .orderBy(desc(schema.events.id))
      .limit(10)
      .all()
      .reverse()
      .map((e) => ({ type: e.type, data: e.data, created_at: e.created_at }));
  }

  return {
    id: row.id,
    chat_id: row.telegramChatId,
    text: row.text,
    image_paths: imagePaths,
    reply_to: replyTo,
    recent_chat: recentMessages.map((m) => ({
      direction: m.direction,
      source: m.source,
      text: m.text,
      worker_id: m.workerId,
    })),
    recent_worker_events: recentEvents,
  };
}

// --- Context for Concierg ---

export function getConciergContext() {
  const projectList = getAllProjects();
  const activeWorkerList = getActiveWorkers();
  const recoverableWorkerList = getRecoverableWorkers();
  return { projects: projectList, activeWorkers: activeWorkerList, recoverableWorkers: recoverableWorkerList };
}
