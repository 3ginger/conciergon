# Changelog

## 0.2.0

### Breaking changes

- **Dispatcher rebuilt around the Agent SDK skill system.** Per-message classification, intent publishing, and acknowledgement now live in `.claude/skills/process-telegram-message/`, invoked by `src/concierg/session.ts` via the SDK. The previous in-process MCP-tool surface (`src/concierg/mcp-tools.ts`) is removed.
- **Database schema reshape.** Tables `events`, `intents`, and `workers` were redesigned around the new dispatcher; a new `telegram_messages` table records every inbound and outbound Telegram message and links events back to it. There are no migration shims — existing local databases from 0.1.x are not carried forward. Delete the old `data/conciergon.db` and let it bootstrap fresh on first run.
- **Worker state enum collapsed to four values** (`starting | active | waiting_input | errored`, with `stopped` reserved as a DB-only audit value). Old values `idle`, `paused`, `waiting_approval`, and `completed` are no longer recognized.
- **Pidfile guard.** `src/utils/pidfile.ts` now refuses to start if another instance holds the lock. Running `npm run dev` while a launchd/systemd-managed instance is up will fail fast instead of fighting for the Telegram polling loop.
- **`WORKER_IDLE_TIMEOUT_S` removed** from the config schema and `.env.example`. The watchdog now uses `WORKER_SESSION_TIMEOUT_S` only.
- **Self-spawn restart removed.** The previous `/restart` handler that re-execed the process is replaced by a clean exit; supervision is the deployment manager's job.

### Added

- `.claude/agents/concierge-agent.md` — named agent identity for the dispatcher.
- `.claude/skills/{process-telegram-message,format-plan,format-question,format-result}/` — per-message and worker-output skills.
- `scripts/_wrapper.sh` and symlinks (`load-message`, `list-workers`, `publish-intent`, `send-message`, `send-photo`, `manage-schedule`) — atomic CLI executables the skills invoke.
- `src/cli/*.ts` — TypeScript implementations behind the symlinked scripts.
- `src/db/message-log.ts` — `telegram_messages` and `events` insert/query helpers.
- `src/markdown/html-document.ts` — HTML renderer used by the formatter pipeline.

### Removed

- `src/concierg/mcp-tools.ts` and its in-process MCP server.
- `concierg-workspace/CLAUDE.md` and `concierg-workspace/haiku-formatter/CLAUDE.md` — the formatter is now an SDK skill, not a workspace prompt.
- All worker-state migration shims in `src/db/index.ts`.
- The legacy `{ question: string }` branch in `parseAskUserQuestion`.

### Changed

- Migrated from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk` for the worker and concierg sessions. `@anthropic-ai/claude-code` remains as the binary the SDK shells out to.
- `WATCHDOG_INTERVAL_MS` default raised from 1500ms to 60000ms (the watchdog only handles idle alerts now).

## 0.1.0

Initial public release.
