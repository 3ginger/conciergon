---
name: format-result
description: Format a worker result or follow-up answer for Telegram mobile display. No tools.
disable-model-invocation: true
allowed-tools:
---

# Format Result

Single-step text formatter. Read the input JSON from the prompt, format the worker's result for Telegram mobile, and output ONLY the formatted text.

## Inputs

The input JSON is provided in the prompt after the skill name ($ARGUMENTS):

!cat $CLAUDE_SKILL_DIR/input-schema.json

## Rules

- **Never use tools.** No Read, Write, Edit, Bash, Glob, Grep, or any other tool.
- **Never ask questions.** Never request clarification.
- **Output only the response text.** No preamble like "Here is the formatted version:".
- **Match the language of the user's task.** If the task or content is in Russian, output in Russian. Never translate. Never default to English.

### Understanding user intent from events

The `events` array shows the worker's activity in chronological order. Key event types:

- **worker_spawning / follow_up** — the user's task. The LATEST one is the current request.
- **tool_use** — `{tool, input}` — files and commands the worker investigated.
- **assistant_message** — `{text}` — the worker's thinking and findings.
- **question_asked / question_answered** — Q&A with the user during the task.
- **plan_proposed / plan_approved / plan_rejected** — plan lifecycle.

Present `result` as a **direct answer** to the LATEST task (the most recent worker_spawning or follow_up event).

- If the user asked a specific question, answer THAT question — don't dump everything the worker found.
- If the worker's output contains more than what was asked, focus on the relevant parts.

### Formatting for Telegram mobile

- Preserve ALL technical content — file paths, code, commands, findings.
- NO markdown tables — use bullet points instead (tables render badly on mobile).
- Short paragraphs (2-3 lines max).
- Bold key points with **bold**.
- Keep output under 3500 characters.
- Do NOT summarize or rephrase technical details — preserve them exactly.
- Use fenced code blocks with language specified (e.g. ```python) when including code.
- Use `> blockquote` for verbose detail — long quotes auto-collapse on mobile.
- Use `##` for section headings and `###` for subsections (they render with visual hierarchy).
- Use numbered lists (`1. 2. 3.`) for sequential steps; bullet lists (`- `) for unordered items.

## Progress tracking

Not applicable — single-step output.

## Steps

### 1. Format and output

Read the JSON from the prompt. Identify the user's task from the latest worker_spawning/follow_up event in `events`. Format `result` as a direct answer for Telegram mobile. Output ONLY the formatted text.
