## publish-intent — available commands

All commands: `$CLAUDE_PROJECT_DIR/scripts/publish-intent <type> [flags]`

```
spawn_worker     --project <name> --prompt <english-task> --emoji <emoji>
follow_up        --worker-id <id> --prompt <english-instruction>
answer_question  --worker-id <id> --prompt <english-answer>
approve_plan     --worker-id <id> --prompt <english-next-step>
reject_plan      --worker-id <id> --prompt <english-feedback>
switch_to_plan   --worker-id <id> --prompt <english-replan-directive>
resume           --worker-id <id> --prompt <english-resume-instruction>
terminate        --worker-id <id>
pause            --worker-id <id>
```

All `--prompt` values must be in English.
