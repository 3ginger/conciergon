# Contributing to Conciergon

## Skill design conventions

These rules come from the `/process-telegram-message` migration and apply to every skill in this repo.

### Structure

- Skills live at `<project-root>/.claude/skills/<skill-name>/SKILL.md`.
- Agents live at `<project-root>/.claude/agents/<agent-name>.md`.
- The SDK session must use `cwd: <project-root>` and `settingSources: ["user", "project"]` so `.claude/` is loaded automatically.

### Scripts: atomic, generic, outside `.claude/`

- Scripts that a skill invokes live at `<project-root>/scripts/<name>` — **NOT** inside the skill directory.
- One script per purpose. **No grouped CLIs with subcommands** (`foo-cli load|list|send` is banned). Each script does one thing.
- **No project-specific prefixes.** Scripts must be generic names (`send-message`, not `concierg-send-message`) so they can be copied to another project and reused without renaming.
- Each script: single-line JSON to stdout on success, non-zero exit + JSON on stderr on failure. Logging libraries may write to stderr — that's fine — but stdout must be machine-parseable.
- Scripts find the DB / `.env` via `$CLAUDE_PROJECT_DIR` — they don't rely on cwd. The existing `scripts/_wrapper.sh` handles this (falls back to the parent of `scripts/` if the env var isn't set, so running scripts outside Claude Code still works).

### How skills invoke scripts

- Always invoke with the full `$CLAUDE_PROJECT_DIR/scripts/<name>` path (Claude Code sets `CLAUDE_PROJECT_DIR` automatically).
- The `allowed-tools` frontmatter in SKILL.md is **CLI-only** — per [SDK skills docs](https://code.claude.com/docs/en/agent-sdk/skills), it is ignored when skills run via the Agent SDK. For SDK-driven skills, set `allowedTools` on the `query()` call instead:
  ```ts
  allowedTools: ["Skill", "Bash", "Read", "TodoWrite", "Agent"]
  ```
  Use `canUseTool` as a narrowing gate to restrict `Bash` to `$CLAUDE_PROJECT_DIR/scripts/*`.

### Mandatory SKILL.md body sections

Every skill body must include these sections, in this order:

1. **`## Inputs`** — document the arguments using **`$ARGUMENTS`** (the full arg string). Anthropic's own docs contradict each other on `$0` vs `$1` for the first positional arg — [skills ref](https://code.claude.com/docs/en/skills) says `$0`, [SDK slash-commands ref](https://code.claude.com/docs/en/agent-sdk/slash-commands) shows `$1`. `$ARGUMENTS` is unambiguous across both.
2. **`## Progress tracking`** — instruct Claude to create a task per step using **`TodoWrite`**, run them sequentially, and block each step on the previous result.
3. **`## Steps`** — numbered steps. Each step should reference one script invocation (or one `Read`), so the skill stays declarative.

### Task tool name (important, commonly wrong)

- **Agent SDK / non-interactive sessions (our case): `TodoWrite`**.
- Interactive Claude Code: `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`.
- The subagent spawner is called **`Agent`**, not `Task`.

### Binding a skill to a named agent

Use both `context: fork` and `agent: <agent-name>` in the skill frontmatter. `agent:` alone is a no-op per the docs.

### Available substitutions in skill body

- **`$ARGUMENTS`** — full arg string as typed. Prefer this.
- `$N` / `$ARGUMENTS[N]` — positional args. **Docs conflict on `$0` vs `$1` for the first arg** (see above); don't rely on a specific index until verified in the runtime you're targeting.
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`.
- Bash-level env: `$CLAUDE_PROJECT_DIR` — use this for repo-level assets (DB, `.env`, `scripts/`).
