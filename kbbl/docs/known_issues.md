# Known Issues

Tracked bugs / surface gaps that aren't blocking but are worth surfacing for future fixers. New entries go at the top.

---

## ~~Run-build guard reads stale `current_session_ref`~~ — RESOLVED

**Resolution:** Option 1 from the original entry below was taken. `GET /cohorts/:id` now resolves `current_session_status` from the live `SessionManager` (`null` if the ref is unknown to the manager, which the guard treats as ended). `RunBuildButton` only shows "Build running" when `current_session_stage === "build"` AND `current_session_status` exists AND is not `"ended"`.

**Residual ~ms race** between brief approval and the dispatcher's `UPDATE cohorts SET current_session_ref = …` write is unchanged — the server's route guard catches double-dispatch, so worst case is one failed POST. Not worth a fix in the client path.

---

### Original entry (kept for context)

**Where:** `core/pwa/review/shared/RunBuildButton.tsx`

**Symptom:** After a build session completes (or fails), the cohort's `current_session_ref` and `current_session_stage='build'` columns remain populated in `kbbl.db`. `RunBuildButton`'s mount-time guard reads those columns from `GET /cohorts/:id` and renders **"Build running — session …"**, hiding the manual recovery button. The user has to wait for an external state change or reload long enough that the columns are overwritten by a new session before the button reappears.

**Why it wasn't fixed in PR #98:** The server-side guard (`core/server/handlers/builds.ts`) already did the right thing — it checks `manager.get(ref).status !== "ended"` before 409'ing a re-dispatch. The mismatch was purely client-side: the cohort GET didn't expose the session's live status.

**Tracking:** raised on PR #98 (Copilot review). Resolved in the follow-up that added `current_session_status` to the cohort response.
