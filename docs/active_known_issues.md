# Active known issues

This document tracks reproducible issues in the current Rust evaluator, DBOS
authority, provider composition and operator PWA. For each new issue, record
the affected version or bundle, a reproduction, observed behavior, and the
expected behavior. Move an entry out of active issues when its fix is verified.

## Frozen v1 operator UI on v2 (v1-data-layer)

- **The repository browser suite remains red (0/2).** Reproduce with
  `cd kbbl && bun run test:browser`: both cases in
  `kbbl/tests/browser/operator-browser.test.ts` time out. Its test server
  answers retired v1 paths such as `/oakridge/api/workflow_defs` and
  `/oakridge/api/workflow_runs`, while the v2 client requests
  `/oakridge/api/api/definitions`, `/oakridge/api/api/runs` and unit views.
  The expected result is browser coverage that seeds the v2 contract and
  exercises the retained v1 UI; the browser fixture is outside this cohort's
  allowed files. The isolated shadow install does render the run list and
  detail, and live button checks verified Cancel and Archive on a disposable
  run and intercepted review decision submissions on the seeded run.
- **No pull request mismatch rows.** The v2 `pull_request.observe` path reports a
  state but does not expose the v1 `PullRequestMismatch` or
  `CohortPullRequestReconciliation` facts. The development inbox adapter never
  emits `pull_request_mismatch`; the corresponding frozen UI remains inactive.
  To reproduce, observe a PR whose branch or repository differs from the v1
  expectation and read `/api/run-inboxes`. Expected: a dedicated mismatch row;
  observed: only the v2 state and decisions.
- **Decision retry after a component remount may be duplicated.** The frozen
  `GateDecisionActions` keeps its ingress request ID in a per-mount `useRef`.
  Remount after an uncertain response and repeat the same click: the new ID
  does not deduplicate the original decision. The v2 ingress endpoint expects
  a stable `request_id` for retries. This requires a freeze exemption to fix
  in the form component.
- **Development decisions with two fields or one non-`feedback` field cannot be
  submitted by the frozen form.** It has one feedback textarea. The adapter
  refuses these decision shapes rather than dropping required data. The current
  development `request_changes` decisions use a single `feedback` field.
- **The default install at `127.0.0.1:8790` still lacks v2 `/api/runs`.** The
  isolated shadow backend at `127.0.0.1:8800` serves v2 and supplied the three
  committed adapter fixtures. The shadow PWA at `127.0.0.1:8798` renders a
  seeded run list and detail in a browser check; the operator confirmed the
  visual checkpoint. Functional validation remains separate. The default
  install needs its database cutover before this PWA branch can run against it.
- **Opaque v1 artifact IDs with no v2 revision identity cannot be resolved.**
  A composite v2 ID resolves on a cold load, and the client can find a bare v2
  revision ID by searching run and unit views. An arbitrary retired v1 UUID
  has no corresponding key in the v2 read contract and returns a clear
  not-found error. An opaque gate ID similarly resolves only when its supplied
  revision and action identify one current v2 review decision.
- **Several frozen v1 controls have no v2 command.** V2 has no run deletion,
  thread ping/resolution, or review-item update endpoint, and the v1 workflow
  graph cannot be compiled as a v2 definition. These client methods now fail
  explicitly. The workflow definition detail can only show a placeholder
  graph because the v1 editor's graph model does not represent a v2 bundle.
- **Final merge response metadata has no v2 equivalent.**
  `confirmFinalPullRequest` submits the v2 `confirm_merged` decision and then
  returns a minimal compatibility `EpicWorkflowProfile` to satisfy its frozen
  v1 signature. Its profile fields are placeholders; the run detail does not
  expose a profile from v2. The decision's committed result is the authority.
- **Frozen run activity still reads `/oakridge/api/run_events`.** V2 exposes
  `GET /events` and per-unit history instead. Opening run activity in the
  frozen workspace requests the retired route. This lies outside the client,
  hooks and adapters files this cohort may change.

## Resolved investigation: group-unit operator decision (review-loop bundle)

Reproduction: launch the `review-loop` sample, then POST `operator_decided` to
`/api/runs/{run_id}/units/{run_id}/reviews/editor/decide` with a valid request
body. The run root is an active group unit. Against the pre-fix evaluator this
returns HTTP 500 and records a `commit_fault` operator event; its subscriber
frame is an `invalidate` for the run. The expected result is a 4xx rejection
explaining that a group cannot carry a stage review, with no commit fault.

Origin: `http/ingress.ts` constructs the event without checking the unit kind;
`storage/commit.ts` passes it to the core. In `workflow-core`'s `reduce.rs`,
`OperatorDecided` calls `checked_stage` on the group. That helper returns
`invalid_snapshot("unit is a group")`, which `stepPinned` classifies as a
commit fault. The refusal is raised by the Rust core's step; the core must
classify this validly formed but inapplicable event as `rejected_event`.

Resolution: the evaluator now rejects stage-only events addressed to a group.
The HTTP caller receives `409` with reason `unit is a group`, while a missing
checked stage on a stage unit remains an invalid snapshot and records a fault.
