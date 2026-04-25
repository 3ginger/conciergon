export const INTENT_TYPES = [
  "spawn_worker",
  "follow_up",
  "answer_question",
  "approve_plan",
  "reject_plan",
  "switch_to_plan",
  "terminate",
  "pause",
  "resume",
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

/** Worker lifecycle states (4-state machine).
 *
 * "stopped" is written directly to DB by cleanupWorker() for audit trail
 * but is NOT part of this enum — stop = abort + remove from pool.
 */
export enum WorkerState {
  /** SDK session is initializing (spawn or restore in progress) */
  Starting = "starting",
  /** Running a query, idle in pool awaiting follow-up, or interrupted */
  Active = "active",
  /** Blocked on AskUserQuestion or ExitPlanMode — awaiting user/manager input */
  WaitingInput = "waiting_input",
  /** Runtime error or API failure — can be restored */
  Errored = "errored",
}

/** Type-specific data for each intent */
export type IntentData =
  | { project: string; prompt: string; emoji: string }  // spawn_worker
  | { prompt: string }                                   // follow_up, reject_plan, switch_to_plan, approve_plan, resume
  | { answer: string }                                   // answer_question
  | Record<string, never>;                               // terminate, pause

export interface ClassifiedIntent {
  type: IntentType;
  workerId: number | null;
  telegramMessageId: number;
  data: IntentData;
}

// --- Event types ---

export const EVENT_TYPES = [
  // Worker lifecycle
  "worker_spawning",
  "worker_started",
  "worker_completed",
  "worker_stopped",
  "worker_paused",
  "worker_resumed",
  "worker_terminated",
  "worker_error",
  // Worker activity
  "status_change",
  "mode_switch",
  "tool_use",
  "assistant_message",
  "result_delivered",
  // User interaction
  "follow_up",
  "question_asked",
  "question_answered",
  "plan_proposed",
  "plan_approved",
  "plan_rejected",
  "plan_document_send_failed",
  // Formatter
  "formatter_started",
  "formatter_done",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

