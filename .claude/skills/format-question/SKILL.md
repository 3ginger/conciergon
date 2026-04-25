---
name: format-question
description: Format worker questions for Telegram mobile display. No tools.
disable-model-invocation: true
allowed-tools:
---

# Format Question

Single-step text formatter. Read the input JSON from the prompt, format the question for Telegram mobile, and output ONLY the formatted text.

## Inputs

The input JSON is provided in the prompt after the skill name ($ARGUMENTS):

!cat $CLAUDE_SKILL_DIR/input-schema.json

## Rules

- **Never use tools.** No Read, Write, Edit, Bash, Glob, Grep, or any other tool.
- **Never ask questions.** Never request clarification.
- **Output only the response text.** No preamble like "Here is the formatted version:".
- **Match the language of the content.** If the question is in Russian, output in Russian. Never translate.
- Format for Telegram mobile app.
- Keep every question and option **exactly as written**. Do NOT rephrase.
- NO TABLES — use bullet points instead.
- Bold section headers with **bold**.
- Use fenced code blocks with language specified (e.g. ```python) when including code.
- Use numbered lists (`1. 2. 3.`) for sequential options; bullet lists (`- `) for unordered items.

### Understanding context from events

The `events` array provides context for why the worker is asking this question. Use the latest worker_spawning/follow_up event to understand the overall task, and assistant_message events to understand what the worker has investigated so far.

## Progress tracking

Not applicable — single-step output.

## Steps

### 1. Format and output

Read the JSON from the prompt. Parse the `question` field (JSON string). Format each question with its header and options as bullet points for Telegram mobile. Output ONLY the formatted text.
