# Known Issues

Tracked bugs / surface gaps that aren't blocking but are worth surfacing for future fixers. New entries go at the top.

---

## Run-build guard reads stale `current_session_ref`

**Where:** `core/pwa/review/shared/RunBuildButton.tsx`

**Symptom:** After a build session completes (or fails), the cohort's `current_session_ref` and `current_session_stage='build'` columns remain populated in `kbbl.db`. `RunBuildButton`'s mount-time guard reads those columns from `GET /cohorts/:id` and renders **"Build running — session …"**, hiding the manual recovery button. The user has to wait for an external state change or reload long enough that the columns are overwritten by a new session before the button reappears.

**Why it's not fixed in-place:** The server-side guard (`core/server/handlers/builds.ts`) already does the right thing — it checks `manager.get(ref).status !== "ended"` before 409'ing a re-dispatch. The mismatch is purely client-side: the cohort GET doesn't expose the session's live status. Closing the gap properly needs one of:

1. **Extend `GET /cohorts/:id`** to include the resolved session status (`active` / `ended`) when `current_session_ref` is set. Cheapest, but couples the cohort record to live session manager state.
2. **New endpoint `GET /sessions/:ref/status`** the button can call to verify before treating `sessionRef` as live. More surface area but cleanly separated.
3. **Clear `current_session_ref` / `current_session_stage` on session end** in the dispatcher lifecycle. Closest to "fix at the source," but means the cohort can no longer carry a stable pointer to its last build session (which the plan-view UX may rely on).

**Residual ~ms race:** Even with the proper fix, there's a small window between brief approval (which auto-dispatches a build) and the dispatcher's `UPDATE cohorts SET current_session_ref = …` write. The button's pre-write fetch can race that — the route guard catches double-dispatch, so the worst case is one extra failed POST.

**Tracking:** raised on PR #98 (Copilot review). Punted to a follow-up cohort.
