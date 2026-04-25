#!/usr/bin/env node
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { insertIntent, getProjectByName } from "../db/queries.js";
import { INTENT_TYPES, type IntentType } from "../types/index.js";
import { bootstrap, out, fail, parseArgs } from "./shared.js";

bootstrap();

const args = process.argv.slice(2);
const type = args[0] as IntentType | undefined;
if (!type) fail("usage: publish-intent <type> [--flags...]");
if (!INTENT_TYPES.includes(type as IntentType)) {
  fail(`invalid intent type: ${type}`, { valid: INTENT_TYPES });
}

const { flags } = parseArgs(args.slice(1));

function num(v: unknown): number | null {
  if (v === undefined || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

const telegramMessageId = num(flags["telegram-message-id"]) ?? 0;
const workerIdFlag = num(flags["worker-id"]);

let data: Record<string, unknown> = {};
switch (type as IntentType) {
  case "spawn_worker": {
    const projectName = str(flags["project"]);
    const prompt = str(flags["prompt"]);
    const emoji = str(flags["emoji"]);
    if (!projectName) fail("spawn_worker requires --project");
    if (!prompt) fail("spawn_worker requires --prompt");
    if (!emoji) fail("spawn_worker requires --emoji");
    const project = getProjectByName(projectName!);
    if (!project) fail(`project not found: ${projectName}`);
    data = { project: project!.name, prompt, emoji };
    break;
  }
  case "follow_up":
  case "reject_plan":
  case "switch_to_plan":
  case "approve_plan":
  case "resume": {
    if (workerIdFlag == null) fail(`${type} requires --worker-id`);
    const prompt = str(flags["prompt"]);
    if (!prompt) fail(`${type} requires --prompt`);
    data = { prompt: prompt! };
    break;
  }
  case "answer_question": {
    if (workerIdFlag == null) fail("answer_question requires --worker-id");
    const prompt = str(flags["prompt"]);
    if (!prompt) fail("answer_question requires --prompt");
    data = { answer: prompt! };
    break;
  }
  case "terminate":
  case "pause": {
    if (workerIdFlag == null) fail(`${type} requires --worker-id`);
    data = {};
    break;
  }
  default:
    fail(`unhandled intent type: ${type}`);
}

const row = insertIntent({
  type: type as IntentType,
  workerId: workerIdFlag,
  telegramMessageId,
  data: data as any,
});

out({ intent_id: row.id, type: row.type, worker_id: row.workerId, created_at: row.createdAt });
