# Conciergon Development Notes

## Project Overview

Conciergon is a Telegram bot that manages Claude Code worker sessions on projects. Per incoming Telegram message, a persistent SDK session invokes the `/process-telegram-message` skill, which classifies intent and publishes actionable rows to the `intents` table; the dispatcher polls and routes them.

## Key Architecture

- `.claude/agents/concierge-agent.md` — Named identity for the dispatcher (minimal body).
- `.claude/skills/process-telegram-message/SKILL.md` — ALL per-message behavior. Invoked by the TypeScript wrapper as `/process-telegram-message <id>` per incoming Telegram message.
- `scripts/` — Generic, atomic CLI executables the skill invokes: `load-message`, `list-workers`, `publish-intent`, `send-message`, `send-photo`, `manage-schedule`. Each is a symlink to `_wrapper.sh` which tsx-runs `src/cli/<name>.ts`.
- `src/concierg/session.ts` — Thin SDK-query wrapper. Per message: inserts a `telegram_messages` row, runs Claude Code SDK with the skill, then polls the `intents` table for new rows and dispatches them.
- `src/dispatcher/index.ts` — Worker orchestration, plan-mode state machine, follow-up routing.
- `src/watchdog/index.ts` — Idle-worker monitoring.
- `src/index.ts` — Telegram intake → concierg wrapper → dispatcher.

## Development

- `npm run dev` — Run with tsx (auto-loads `.env`). Restart after code changes to pick them up.
- `npm run build` — TypeScript compile to `dist/`.
- For production deployments under launchd or systemd, use the platform's restart command (see `docs/deployment.md`). `npm run dev` and a service-managed instance must not run simultaneously — they will fight for the Telegram polling lock.

See `CONTRIBUTING.md` for skill/script design conventions when extending the codebase.
