# Dispatcher — Worker Session Resolution

## Intent Routing

Intent handlers resolve a session, mutate its plan-mode state if needed, then hand off
to `deliverPrompt()`, which decides whether to warm up (cold) or follow up (warm).

```
User sends message
  -> Concierg classifies intent
  -> Dispatcher.handleIntent()
     |
     +-- resolveSession(workerId, context)
     |     |
     |     +-- In pool -> return { session, id }
     |     |
     |     +-- Not in pool, found in DB with sessionId
     |     |     -> createSessionFromDb() adds cold session to pool
     |     |     -> return { session, id }  (session may be cold)
     |     |
     |     +-- Not in pool, not in DB (or no sessionId)
     |           -> notify "Worker #N not found"
     |           -> return null
     |
     +-- intent-specific mutation on session (e.g. switchToExecution, switchToPlanning,
     |   approvePlan, rejectPlan) — flips _permissionMode and DB before warm-up
     |
     +-- deliverPrompt(session, id, prompt)
           |
           +-- cold -> warmUp(sessionId, prompt)  (prompt becomes initial resume prompt)
           |
           +-- warm -> followUp(prompt)           (interrupts current query)
```

Splitting resolution from delivery is what lets `approvePlan` flip
`workers.permission_mode` to `'default'` *before* the SDK session starts on a cold
resume — otherwise the warmed-up session would read `'plan'` from the DB and
re-enter plan mode even though the user already approved.

## Cold Start

```
Server starts
  -> cleanupStaleWorkers()
     |
     +-- Get all active workers from DB
     +-- Mark stale workers as stopped (exceeded WORKER_RESUME_MAX_AGE_S)
     +-- Mark workers with no sessionId as errored
     +-- Mark completed workers as stopped
     |
     (Pool is empty — no pre-loading)

First message targeting Worker #N arrives:
  -> resolveSession() -> createSessionFromDb() adds cold session to pool
  -> deliverPrompt() -> warmUp() with the message as initial resume prompt
```

Workers are loaded from DB on demand, not pre-loaded on startup.
