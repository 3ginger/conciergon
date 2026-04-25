#!/usr/bin/env node
import { eq, and, desc, sql } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { getConciergContext, getAllScheduledTasks, getWorkerRecentMessages } from "../db/queries.js";
import { getWorkerSpawnPrompt } from "../db/message-log.js";
import { bootstrap, out } from "./shared.js";

bootstrap();

const ctx = getConciergContext();
const projectById = new Map(ctx.projects.map((p) => [p.id, p]));

function buildWorker(w: typeof schema.workers.$inferSelect, recoverable: boolean) {
  const project = projectById.get(w.projectId);
  const prompt = getWorkerSpawnPrompt(w.id);
  const recent = getWorkerRecentMessages(w.id, 3).reverse().map((e) => {
    const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    return { text: (d as any)?.text ?? "", created_at: e.createdAt };
  });

  // Detect pending plan: last plan_proposed event without a subsequent plan_approved / plan_rejected
  const planEvents = getDb()
    .select({ id: schema.events.id, type: schema.events.type, createdAt: schema.events.createdAt })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, w.id),
        sql`${schema.events.type} IN ('plan_proposed', 'plan_approved', 'plan_rejected')`,
      ),
    )
    .orderBy(desc(schema.events.id))
    .limit(1)
    .get();
  const hasPendingPlan = planEvents?.type === "plan_proposed";

  // Phase: plan mode → planning, default mode → executing
  const phase = w.permissionMode === "plan" ? "planning" : "executing";

  return {
    id: w.id,
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
    state: w.state,
    emoji: w.emoji,
    phase,
    has_pending_plan: hasPendingPlan,
    permission_mode: w.permissionMode,
    session_id: w.sessionId,
    last_activity_at: w.lastActivityAt,
    created_at: w.createdAt,
    recoverable,
    spawn_prompt: prompt,
    recent_messages: recent,
  };
}

const workers = [
  ...ctx.activeWorkers.map((w) => buildWorker(w, false)),
  ...ctx.recoverableWorkers.map((w) => buildWorker(w, true)),
];

// Pending questions: workers in waiting_input with a question_asked event without a subsequent question_answered
const pendingQuestions: Array<{ worker_id: number; question: string; created_at: string; emoji: string | null }> = [];
for (const w of ctx.activeWorkers) {
  if (w.state !== "waiting_input") continue;
  const qa = getDb()
    .select({ type: schema.events.type, data: schema.events.data, createdAt: schema.events.createdAt })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.workerId, w.id),
        sql`${schema.events.type} IN ('question_asked', 'question_answered')`,
      ),
    )
    .orderBy(desc(schema.events.id))
    .limit(1)
    .get();
  if (qa?.type === "question_asked") {
    const d = typeof qa.data === "string" ? JSON.parse(qa.data) : qa.data;
    pendingQuestions.push({
      worker_id: w.id,
      question: (d as any)?.question ?? "",
      created_at: qa.createdAt,
      emoji: w.emoji,
    });
  }
}

const schedules = getAllScheduledTasks().map(({ schedule, project }) => ({
  id: schedule.id,
  project: project.name,
  cron: schedule.cronExpression,
  timezone: schedule.timezone,
  prompt: schedule.prompt,
  user_summary: schedule.userSummary,
  emoji: schedule.emoji,
  enabled: schedule.enabled,
  run_once: schedule.runOnce,
  last_run_at: schedule.lastRunAt,
}));

out({
  projects: ctx.projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
  workers,
  pending_questions: pendingQuestions,
  schedules,
});
