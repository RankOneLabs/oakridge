# Known issues

Tracked issues that are not yet fixed but are understood and have a planned
mitigation. Each entry should describe the failure mode, who's affected,
and the work needed to close it.

## TOCTOU race in `POST /briefs/:id/build`

**File:** `kbbl/core/server/handlers/builds.ts`

The double-dispatch guard reads `cohorts.current_session_ref` and then calls
`dispatcher.dispatch("build", brief_id)` in two separate steps. Two concurrent
POSTs can both observe a null `current_session_ref`, both pass the guard, and
both spawn a build session for the same brief.

**In practice:** the realistic trigger paths are largely closed by UI guards
but a residual race window remains:

- *Double-click on Run-build*: blocked at the button (`disabled={pending}`).
- *Manual click while the auto-dispatch fired by `brief.approved` is in flight*:
  `RunBuildButton` mounts in a "Checking build status…" state and looks up
  `cohorts.current_session_ref` before offering the button. If the auto-dispatch
  already claimed the cohort, the manual button is never shown. The residual
  race is the ~ms window between `brief.approved` emitting and the dispatcher's
  `UPDATE cohorts SET current_session_ref = …` committing — too small for an
  operator to hit through the UI in practice.
- *Direct curl/script spam* or *two operators racing across tabs/devices*:
  still reachable, since neither has a UI gate.

**Fix when prioritized:** replace the check-then-dispatch with an atomic
compare-and-set: `UPDATE cohorts SET current_session_ref = :new_ref WHERE
id = :cohort_id AND current_session_ref IS NULL`. Proceed only when the UPDATE
changes a row. On dispatch failure, roll the claim back by clearing
`current_session_ref`.

Originally surfaced by CodeRabbit on PR #82; Copilot re-flagged the
manual-vs-auto trigger path on the same PR.
