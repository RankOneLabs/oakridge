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

## No unit coverage for sidebar session→project grouping

**File:** `kbbl/core/pwa/sidebar/Sidebar.tsx`

`indexSessionsByProject` is the load-bearing function that maps in-memory
sessions to the project nodes in the new collapsible sidebar. It owns two
subtle behaviors that are easy to regress on:

- *Longest-prefix selection* — when a project repo is nested inside another
  (e.g. `/code/oakridge` and `/code/oakridge/kbbl` both registered), sessions
  must attach to the deeper project.
- *Path-segment boundary matching* — `isWorkdirInProject` deliberately rejects
  raw `startsWith`, so `/repo/app2` does not falsely match `/repo/app`. Easy
  to break by reintroducing a `repo_path` prefix check elsewhere.

The function is exported but currently uncovered. The PWA already has Vitest
infra (`kbbl/core/pwa/vitest.config.ts`) but tests there don't execute under
the project's `bun run test` runner because of the documented `vi.stubGlobal`
incompatibility — wiring vitest into CI is the prerequisite, then a small
suite covering: longest-prefix, sibling-suffix non-match, trailing-slash
normalization, mixed POSIX/Windows separators, and the `projectWorkdir`
fallback path used in `App.tsx`.

Originally surfaced by Copilot on PR #83.

## Sidebar shows "none" flicker before specs load

**File:** `kbbl/core/pwa/sidebar/Sidebar.tsx`

When the operator expands a project for the first time, `fetchSpecsFor` is
fired asynchronously and the Plans/Epics section renders `projSpecs.length
=== 0 ? "none" : …`. During the ~tens-of-ms between expand and the fetch
resolving, the section briefly shows "none" even when the project actually
has specs. Looks like data, isn't.

**Fix when prioritized:** track a per-project in-flight set (e.g.
`Set<string>` of project IDs currently fetching) and render "loading…"
instead of "none" while that ID is in flight. Three render branches
(loading / empty / list) instead of two, plus a small bit of state plumbing
in `fetchSpecsFor`.

Originally surfaced by Copilot on PR #83.

## Delegated-session callbacks are not durable (no outbox)

**Files:** `oakridge-core/src/executor/delegated_session/mod.rs`,
`oakridge-core/src/http/rest.rs`, `kbbl/core/server/callbacks.ts`

The kbbl → oakridge seam (Part C) delivers artifact-emit and terminal-status
callbacks as **fire-and-forget** HTTP POSTs. The `execute()` reorder
("be live before the remote call") closes the *self-inflicted* race where a
callback arrived before the stage was Running / in the live map, and kbbl's
`POST /sessions` is now idempotent on `stage_instance_id` so a recovery
re-POST rebinds the live session instead of spawning a duplicate. What
remains:

- **Callback durability.** If oakridge is down/restarting when kbbl fires a
  terminal status or artifact emit, that POST is lost. The stage then relies
  on `Coordinator::recover()` reconciliation on the next oakridge start to
  converge — delayed, not silent loss, because kbbl remains the source of
  truth (durable transcript).
- **Residual duplicate-session window.** A crash *between* kbbl creating the
  session and oakridge persisting the returned sid in `external_ref` still
  causes a re-POST on recovery. The kbbl-side idempotency index closes this
  in practice (same `stage_instance_id` → same session); it would only
  reappear if that index were lost (kbbl restart) in the same window.

**Decision (do not re-litigate):** a durable message queue / broker is **not**
warranted at current scale — this is loopback, co-located kbbl + oakridge on
one host, low callback volume. The correct durability design when it *is*
warranted is an **outbox + idempotent consumer**, not a broker: kbbl persists
pending callbacks and retries with backoff (at-least-once); oakridge applies
them idempotently (the `set_status` terminal-guard and slot-keyed emit are
already idempotent). A Postgres/SQLite outbox table, no new infra.

**Trigger to build it:** the moment kbbl moves off-host from oakridge (the
spec §10 "extract the runtime into a standalone service" step), or the first
time a real workflow loses a terminal-status callback to an oakridge restart.
Until then, fire-and-forget + recovery reconciliation is sufficient.

## PR #264 review — deferred follow-ups

Items raised in the PR #264 (epic→main) review round and consciously deferred
after operator triage. Each is understood and non-blocking for the merge.

- **`relaunch()` drops delegated wiring.** `kbbl/core/session/session-manager.ts`
  `relaunch()` rebuilds a plain `Session`: its `onEnded` does not restore
  `delegatedConfigs` / `delegatedByStageInstance` and does not report terminal
  status. So a relaunched delegated session would never report back to oakridge
  and could not forward approvals — the stage would strand. **Currently
  dormant:** `manager.relaunch()` has no non-test caller, so a mid-flight crash
  strands the stage regardless (no auto-relaunch exists yet). Close this *with*
  the crash-recovery wiring (restore the delegated config from the snapshot and
  re-report terminal status), alongside the callback-durability outbox above.

- **Delegated callbacks are unauthenticated** (`oakridge-core/src/http/rest.rs`
  artifact / terminal-status / approval handlers). State-mutating, identified
  only by `stage_instance_id`. Safe only because they're loopback-bound in the
  co-located deployment. Add a shared-secret / mTLS verifier on the **same
  trigger** as the durability outbox: when kbbl moves off-host.

- **Terminal status is always `"done"`** (`kbbl/core/server/callbacks.ts`,
  `session-manager.ts` `onEnded`). A non-zero runtime exit is still reported as
  `done`, so a failed delegated stage reads as successful. Thread the real
  terminal outcome through `onEnded` and map non-zero / event-loop errors to
  `"failed"`. Deferred (larger lifecycle change).

- **Typed contracts on the C.1 surface.** `callbacks.ts` helpers should return a
  `Result<void, DelegatedCallbackError>` (operation + `stage_instance_id` +
  detail) instead of collapsing failures to `console.error`; `POST /sessions`
  should parse into a named `CreateSessionRequest` via a `Result`-returning
  validator rather than reconstructing from `Record<string, unknown>`. (The
  callback *field* shapes — base_url/paths/stage_instance_id — already get
  up-front validation as of the #264 fixes; this is the broader typing pass.)
