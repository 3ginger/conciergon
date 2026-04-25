#!/usr/bin/env node
import cron from "node-cron";
import {
  insertScheduledTask,
  getAllScheduledTasks,
  getScheduledTaskById,
  deleteScheduledTask,
  updateScheduledTaskEnabled,
  getProjectByName,
} from "../db/queries.js";
import { bootstrap, getConfig, out, fail, parseArgs } from "./shared.js";

bootstrap();

const args = process.argv.slice(2);
const action = args[0];
const { flags } = parseArgs(args.slice(1));

function num(v: unknown): number | null {
  if (v === undefined || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

switch (action) {
  case "create": {
    const projectName = str(flags["project"]);
    const cronExpression = str(flags["cron"]);
    const prompt = str(flags["prompt"]);
    const userSummary = str(flags["user-summary"]);
    const emoji = str(flags["emoji"]) ?? undefined;
    const chatId = num(flags["chat-id"]);
    const timezone = str(flags["timezone"]) ?? getConfig().USER_TIMEZONE;
    const runOnce = flags["run-once"] === true || flags["run-once"] === "true";

    if (!projectName) fail("create requires --project");
    if (!cronExpression) fail("create requires --cron");
    if (!prompt) fail("create requires --prompt");
    if (!userSummary) fail("create requires --user-summary");
    if (chatId == null) fail("create requires --chat-id");

    if (!cron.validate(cronExpression!)) fail(`invalid cron expression: ${cronExpression}`);

    const project = getProjectByName(projectName!);
    if (!project) fail(`project not found: ${projectName}`);

    const row = insertScheduledTask({
      projectId: project!.id,
      cronExpression: cronExpression!,
      timezone,
      prompt: prompt!,
      userSummary: userSummary!,
      emoji,
      telegramChatId: chatId!,
      runOnce,
    });
    out({ schedule_id: row.id, cron: row.cronExpression, timezone: row.timezone, run_once: row.runOnce });
    break;
  }
  case "list": {
    const chatId = num(flags["chat-id"]);
    const rows = getAllScheduledTasks(chatId ?? undefined).map(({ schedule, project }) => ({
      id: schedule.id,
      project: project.name,
      cron: schedule.cronExpression,
      timezone: schedule.timezone,
      user_summary: schedule.userSummary,
      emoji: schedule.emoji,
      enabled: schedule.enabled,
      run_once: schedule.runOnce,
      last_run_at: schedule.lastRunAt,
    }));
    out({ schedules: rows });
    break;
  }
  case "delete": {
    const id = num(flags["schedule-id"]);
    if (id == null) fail("delete requires --schedule-id");
    const existing = getScheduledTaskById(id!);
    if (!existing) fail(`schedule not found: ${id}`);
    deleteScheduledTask(id!);
    out({ schedule_id: id, deleted: true });
    break;
  }
  case "enable":
  case "disable": {
    const id = num(flags["schedule-id"]);
    if (id == null) fail(`${action} requires --schedule-id`);
    const existing = getScheduledTaskById(id!);
    if (!existing) fail(`schedule not found: ${id}`);
    updateScheduledTaskEnabled(id!, action === "enable");
    out({ schedule_id: id, enabled: action === "enable" });
    break;
  }
  default:
    fail("usage: manage-schedule <create|list|delete|enable|disable> [--flags]");
}
