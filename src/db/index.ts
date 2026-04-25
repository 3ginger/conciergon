import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config/index.js";
import * as schema from "./schema.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

export function initDb() {
  const config = getConfig();
  mkdirSync(dirname(config.DB_PATH), { recursive: true });

  _sqlite = new Database(config.DB_PATH);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });

  // Create tables
  createTables(_sqlite);

  log.info("Database initialized at %s", config.DB_PATH);
  return _db;
}

function createTables(sqlite: Database.Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      session_id TEXT,
      state TEXT NOT NULL DEFAULT 'starting',
      emoji TEXT,
      permission_mode TEXT NOT NULL DEFAULT 'plan',
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      worker_id INTEGER REFERENCES workers(id),
      data TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      prompt TEXT NOT NULL,
      user_summary TEXT NOT NULL,
      emoji TEXT,
      telegram_chat_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      run_once INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      max_errors INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS telegram_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER NOT NULL,
      telegram_chat_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      source TEXT NOT NULL,
      text TEXT,
      image_paths TEXT,
      reply_to_telegram_message_id INTEGER,
      worker_id INTEGER REFERENCES workers(id),
      intent_id INTEGER REFERENCES intents(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL REFERENCES workers(id),
      type TEXT NOT NULL,
      data TEXT,
      message_id INTEGER REFERENCES telegram_messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];

  for (const stmt of statements) {
    sqlite.prepare(stmt).run();
  }

  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_tgmsg_lookup ON telegram_messages(telegram_message_id, telegram_chat_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_tgmsg_worker ON telegram_messages(worker_id, created_at)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_tgmsg_worker_dir ON telegram_messages(worker_id, direction)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_events_worker ON events(worker_id, created_at)").run();
}

export function getDb() {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

export function closeDb() {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export { schema };
