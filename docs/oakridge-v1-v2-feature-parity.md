# Oakridge v1 → v2 feature parity

This is the release checklist for the built-in `dev-flow`. A v2 version is not
feature-parity complete while any **required** row is not `parity`.

Status meanings:

- `parity` — the operator can complete the v1 outcome in v2, including the UI.
- `partial` — some of the outcome exists, but the normal end-to-end path breaks.
- `missing` — no supported v2 path exists.
- `different` — intentionally replaced by an equivalent v2 concept.

| v1 operator capability | v2 implementation | Status | Required work |
|---|---|---:|---|
| Create project and epic from repository + spec | Project + workflow run launcher | parity | — |
| Select planner and worker runtime/model | Run launcher role pickers | parity | — |
| Analyze the spec and record discrepancies | `dev.spec_analysis`, review items, artifact gate | parity | — |
| Resolve/waive every discrepancy before approval | Configurable zero-open-review-items gate | parity | — |
| Review, directly edit, comment on, and approve the plan | Plan artifact viewer, review items, revision emits, artifact gate | partial | Make the distinction between editing review items and revising the plan artifact explicit in the UI. |
| Reject and reopen a plan or brief without losing history | `request_revision` creates another artifact revision | different | Display revision lineage and the active revision prominently. |
| Produce and review one brief per cohort | Plan cohort records are the typed build brief | different | Keep the cohort brief visible from admission through assessment. |
| Respect cohort dependency order | Fan-out `depends_on` scheduler | parity | — |
| Explicitly start/admit eligible cohorts | Manual unit admission + Review Inbox | parity | — |
| Isolate each cohort in a worktree | kbbl managed worktrees | parity | — |
| Base cohort branches on the epic branch | `dev-flow` v7 `/epic_branch` binding | parity | Launcher requires an existing `epic/*` remote branch; worktrees use `origin/<epic_branch>`. |
| Open every cohort PR into the epic branch | v7 build prompt requires `open_pr(base: EPIC_BRANCH)` | parity | Keep the base branch visible beside the PR in review UI. |
| Review build artifacts before merge | Build artifact approval gate | parity | — |
| Confirm merge/closure before unlocking dependents | Merge-confirmation gate | parity | — |
| Merge epic into `main` only when every cohort is complete | External GitHub operation | partial | Add an epic-completion summary and final merge-confirmation surface; never open cohort PRs into `main`. |
| Run assessment for every completed cohort | Per-unit assessor inheriting build worktree | parity | — |
| Block/unblock a cohort manually | Dependency/admission states only | missing | Add explicit operator pause/resume preserving the prior lifecycle state. |
| Retry failed/stuck work without disturbing siblings | Targeted unit retry | partial | Expose failed-unit retry in the Review Inbox, not only stuck-stage retry. |
| Survive coordinator restart | Persisted units + recovery reattachment | partial | Artifact emission must survive restart and kbbl resume/compaction; it currently depends on an in-memory live-session entry. |
| Survive kbbl session resume/compaction | kbbl creates successor sessions | missing | Propagate successor session identity to core or issue a durable stage/unit emit capability. This is an end-to-end blocker. |
| View and act on tool approvals | kbbl session approval cards | partial | Link the active delegated session and pending approvals directly from the v2 run/review UI. |
| Archive/unarchive the work item | Run archive/unarchive | parity | — |
| Delete the work item and owned DB state | Run delete | parity | Verify and document artifact/session audit retention semantics. |
| Understand current stage and next operator action | Run detail + Review Inbox | partial | Show a single next-action summary and surface failed units even when the aggregate run is parked. |
| Operate on desktop and narrow screens | Responsive Oakridge PWA | parity | Maintain browser smoke coverage. |

## End-to-end release gate

Before promoting an epic branch to `main`, exercise this sequence against a real
repository from the PWA:

1. Create the remote `epic/<slug>` branch and launch `dev-flow` with that exact branch.
2. Review/revise/approve spec analysis and plan artifacts.
3. Admit cohorts, including dependent cohorts, and compact or resume at least one live build session.
4. Verify every cohort worktree starts at `origin/epic/<slug>` and every cohort PR targets `epic/<slug>`.
5. Review the build artifact, merge the cohort PR, confirm the merge, and verify dependents unlock.
6. Verify assessment completes per cohort and the run exposes one unambiguous final epic action.
7. Merge the epic branch to `main` only after all cohorts and assessments complete.

The resume/compaction emit test is mandatory: without it, a successful build can
become an unrecoverable failed unit after its successor session tries to emit.
