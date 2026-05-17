# Known issues

Tracked issues that are not yet fixed but are understood and have a planned
mitigation. Each entry should describe the failure mode, who's affected,
and the work needed to close it.

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
