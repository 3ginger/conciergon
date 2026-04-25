---
name: process-telegram-message
description: Process one incoming Telegram message — classify intent, publish if actionable, acknowledge the user.
disable-model-invocation: true
allowed-tools: Bash($CLAUDE_PROJECT_DIR/scripts/*) Read TodoWrite
---

# Process Telegram Message

Single-shot: classify one Telegram message, publish intent if needed, always acknowledge the user. All communication with workers is in English.

## Input

The message JSON is provided in the prompt after the skill name:

!cat $CLAUDE_SKILL_DIR/input-schema.json

## Progress tracking

Create tasks for each step. Run sequentially. If any step fails, still send an error ack.

## Steps

### 1. Parse input

Read the message JSON from the prompt. If `image_paths` is non-empty, `Read` each path.

`reply_to` (if present) is the full resolved message being replied to — `direction`, `source`, `text`, `worker_id` are already there.

### 2. Explore worker state

```
$CLAUDE_PROJECT_DIR/scripts/list-workers
```

Returns: `{ projects[], workers[], pending_questions[], schedules[] }`.

Workers in `active`/`waiting_input` are ALIVE. Workers with `state=stopped` and non-null `session_id` are recoverable via `follow_up` (cold-resume happens transparently).

### 3. Classify the user's intention

Using Steps 1 + 2, classify into exactly ONE branch:

#### Branch A — About an existing worker

Detect: `reply_to.direction=out` with `reply_to.worker_id`, OR user mentions worker emoji/id/project.

- **answer_question** — reply to a pending question
- **approve_plan** — approves a plan, worker has `has_pending_plan=true`
- **reject_plan** — rejects/corrects a plan, `has_pending_plan=true`
- **switch_to_plan** — executing worker should go back to planning
- **follow_up** — any other instruction/correction (default for replies)
- **terminate / pause / resume** — lifecycle commands

Tie-breakers: instruction *to* a worker = `follow_up`. Never spawn for replies to existing workers. Never say a recoverable worker is "stopped" — route with `follow_up`.

#### Branch B — New project task

User asks for something new on a specific project → **spawn_worker** with `--project <name>`.

#### Branch C — Addressed to Conciergon (no worker, no project)

Can you answer with only `send-message` and Steps 1-2 data?

- **Yes** → no intent. Reply directly in Step 5. This includes:
  - Greetings, smalltalk
  - Meta-questions about Conciergon
  - Status questions about workers ("how's it going", "is it done") — answer from Step 2 data
- **No** (needs web search, code, commands, analysis) → **spawn_worker --project general**

Default in ambiguity: `spawn_worker --project general`. You are a dispatcher, not a worker.

#### Unclear intent

If the user's intent is ambiguous and you can't confidently classify, ask a short clarification question via `send-message` and exit without publishing an intent.

### 4. Publish intent (skip for direct-reply, clarification)

Use `$CLAUDE_PROJECT_DIR/scripts/publish-intent` with the classified type. See **References** for available commands.

**Prompt rules:**
- All `--prompt` values must be in English. Understand the user's intent, translate and rephrase clearly. NEVER add tools/frameworks/approaches the user didn't mention.
- The dispatcher passes `--prompt` verbatim to the worker. Your prompt IS the worker's message — make it complete and actionable. No wrapping happens downstream.
- `approve_plan`, `resume`, and `switch_to_plan` all require a prompt. Even bare confirmations ("yes") become something like "Proceed with the approved plan."
- `--emoji`: assign the most relevant emoji for the task theme.

### 5. Acknowledge the user (ALWAYS — last step)

```
$CLAUDE_PROJECT_DIR/scripts/send-message --chat-id <chat_id> --text <ack>
```

MANDATORY ack format — you MUST use exactly this structure:

- Worker-targeted: `[<emoji>#<id>][<action>] <the english text you sent to the worker>`
- Spawn: `[<emoji>][spawn_worker] <project>: <task summary>`
- Direct reply: conversational, concise
- Clarification: your question to the user
- Error: `⚠️ <reason>`

Example (worker follow_up):
  [🔧#3][follow_up] Fix the login timeout by increasing the session TTL

Example (spawn):
  [📊][spawn_worker] finflow: Generate Q1 revenue report

NEVER write free-form ack text. ALWAYS use the bracket format for worker-targeted and spawn acks.

HTML is supported — you may use `<b>`, `<i>`, `<code>` tags in ack text.

## Hard rules

- No `Bash` outside `$CLAUDE_PROJECT_DIR/scripts/*`.
- NEVER investigate yourself — delegate to `spawn_worker`.
- All worker communication in English. Translate user messages, but don't inject your own technical choices.
- NEVER skip Step 5.

## References

Historical message lookup (for additional context beyond what's pre-baked):
```
$CLAUDE_PROJECT_DIR/scripts/load-message <db-id>
$CLAUDE_PROJECT_DIR/scripts/load-message --telegram-id <id> --chat-id <chat-id>
```

Available intent commands:

!cat $CLAUDE_SKILL_DIR/intent-commands.md

## Reminder — Ack format (Step 5)

ALWAYS use the structured `[emoji#id][action]` format for worker-targeted and spawn acks. NEVER write free-form text for these. See Step 5 for the exact template.
