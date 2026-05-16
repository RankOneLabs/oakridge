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

**In practice:** unreachable through the PWA — the Run-build button disables
itself on click (`disabled={pending}` in `BriefReviewView.tsx`). Only reachable
via direct curl/script spam or two operators racing across tabs.

**Fix when prioritized:** replace the check-then-dispatch with an atomic
compare-and-set: `UPDATE cohorts SET current_session_ref = :new_ref WHERE
id = :cohort_id AND current_session_ref IS NULL`. Proceed only when the UPDATE
changes a row. On dispatch failure, roll the claim back by clearing
`current_session_ref`.

Originally surfaced by CodeRabbit on PR #82.
