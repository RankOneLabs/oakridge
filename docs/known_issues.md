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
