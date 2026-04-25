import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  path: text("path").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const intents = sqliteTable("intents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // IntentType
  telegramMessageId: integer("telegram_message_id").notNull(),
  workerId: integer("worker_id").references(() => workers.id),
  data: text("data", { mode: "json" }), // type-specific args (see IntentData types)
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const workers = sqliteTable("workers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  sessionId: text("session_id"),
  state: text("state").notNull().default("starting"), // WorkerState enum: starting | active | waiting_input | errored (+ "stopped" DB-only)
  emoji: text("emoji"),
  permissionMode: text("permission_mode").notNull().default("plan"), // 'plan' | 'default'
  lastActivityAt: text("last_activity_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});


export const scheduledTasks = sqliteTable("scheduled_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  cronExpression: text("cron_expression").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  prompt: text("prompt").notNull(),
  userSummary: text("user_summary").notNull(),
  emoji: text("emoji"),
  telegramChatId: integer("telegram_chat_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runOnce: integer("run_once", { mode: "boolean" }).notNull().default(false),
  lastRunAt: text("last_run_at"),
  errorCount: integer("error_count").notNull().default(0),
  maxErrors: integer("max_errors").notNull().default(3),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});


export const telegramMessages = sqliteTable("telegram_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramMessageId: integer("telegram_message_id").notNull(),
  telegramChatId: integer("telegram_chat_id").notNull(),
  direction: text("direction").notNull(), // 'in' | 'out'
  source: text("source").notNull(), // user_text, user_photo, user_edit, callback_query, concierg, worker_plan, worker_question, worker_result, worker_progress, worker_error, system
  text: text("text"),
  imagePaths: text("image_paths", { mode: "json" }),
  replyToTelegramMessageId: integer("reply_to_telegram_message_id"),
  workerId: integer("worker_id").references(() => workers.id),
  intentId: integer("intent_id").references(() => intents.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workerId: integer("worker_id")
    .notNull()
    .references(() => workers.id),
  type: text("type").notNull(),
  data: text("data", { mode: "json" }),
  messageId: integer("message_id").references(() => telegramMessages.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
