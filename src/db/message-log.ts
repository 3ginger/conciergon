import { eq, and, sql, desc, isNotNull } from "drizzle-orm";
import { getDb } from "./index.js";
import * as schema from "./schema.js";
import { EVENT_TYPES, type EventType } from "../types/index.js";

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

// --- Types ---

export interface TelegramMessageInsert {
  telegramMessageId: number;
  telegramChatId: number;
  direction: "in" | "out";
  source: string;
  text?: string | null;
  imagePaths?: string[] | null;
  replyToTelegramMessageId?: number | null;
  workerId?: number | null;
  intentId?: number | null;
}

export interface EventInsert {
  workerId: number;
  type: EventType;
  data?: Record<string, unknown>;
  messageId?: number | null;
}

// --- Telegram Messages ---

export function insertTelegramMessage(msg: TelegramMessageInsert) {
  return getDb()
    .insert(schema.telegramMessages)
    .values({
      telegramMessageId: msg.telegramMessageId,
      telegramChatId: msg.telegramChatId,
      direction: msg.direction,
      source: msg.source,
      text: msg.text ?? null,
      imagePaths: msg.imagePaths ?? null,
      replyToTelegramMessageId: msg.replyToTelegramMessageId ?? null,
      workerId: msg.workerId ?? null,
      intentId: msg.intentId ?? null,
    })
    .returning()
    .get();
}

export function updateMessageWorkerId(id: number, workerId: number) {
  return getDb()
    .update(schema.telegramMessages)
    .set({ workerId })
    .where(eq(schema.telegramMessages.id, id))
    .run();
}

export function updateMessageIntentId(id: number, intentId: number) {
  return getDb()
    .update(schema.telegramMessages)
    .set({ intentId })
    .where(eq(schema.telegramMessages.id, id))
    .run();
}

export function getWorkerByOutgoingMessage(
  telegramMessageId: number,
  telegramChatId: number,
): number | null {
  const row = getDb()
    .select({ workerId: schema.telegramMessages.workerId })
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramMessageId, telegramMessageId),
        eq(schema.telegramMessages.telegramChatId, telegramChatId),
        eq(schema.telegramMessages.direction, "out"),
        isNotNull(schema.telegramMessages.workerId),
      ),
    )
    .limit(1)
    .get();
  return row?.workerId ?? null;
}

// --- Events ---

export function insertEvent(event: EventInsert) {
  if (!EVENT_TYPE_SET.has(event.type)) {
    throw new Error(`Invalid event type: "${event.type}". Valid: ${EVENT_TYPES.join(", ")}`);
  }
  return getDb()
    .insert(schema.events)
    .values({
      workerId: event.workerId,
      type: event.type,
      data: event.data ?? null,
      messageId: event.messageId ?? null,
    })
    .returning()
    .get();
}

/**
 * Get all events from the most recent worker_spawning or follow_up event to now.
 * This is the formatter's context window — everything the worker did since the last task.
 */
export function getEventsSinceLastTask(workerId: number) {
  // Find the last task-defining event
  const lastTask = getDb()
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        sql`${schema.events.type} IN ('worker_spawning', 'follow_up')`,
      ),
    )
    .orderBy(desc(schema.events.id))
    .limit(1)
    .get();

  if (!lastTask) return [];

  return getDb()
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        sql`${schema.events.id} >= ${lastTask.id}`,
      ),
    )
    .orderBy(schema.events.id)
    .all();
}

/** Get the worker's original spawn prompt from the worker_spawning event. */
export function getWorkerSpawnPrompt(workerId: number): string | null {
  const row = getDb()
    .select({ data: schema.events.data })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, workerId),
        eq(schema.events.type, "worker_spawning"),
      ),
    )
    .limit(1)
    .get();
  if (!row?.data) return null;
  const d = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  return (d as any)?.prompt ?? null;
}

