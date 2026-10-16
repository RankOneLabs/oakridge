# Active known issues

This document tracks reproducible issues in the current Rust evaluator, DBOS
authority, provider composition and operator PWA. For each new issue, record
the affected version or bundle, a reproduction, observed behavior, and the
expected behavior. Move an entry out of active issues when its fix is verified.

## Frozen v1 operator UI on v2 (v1-data-layer)

- **Browser coverage now seeds the v2 contract, but is narrow.** The two
  browser cases exercise launch/read-back and run-workspace loading against
  the captured v2 run fixture. They pass with
  `cd kbbl && bun run test:browser`.
  They do not yet automate every control in the frozen UI. The isolated shadow
  install rendered the run list and detail; live button checks verified Cancel
  and Archive on a disposable run and intercepted review decision submissions
  on the seeded run.
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
  committed adapter fixtures. The shadow PWA at `127.0.0.1:8798` renders the
  live Shelly run `run-072ecbd42a8f7169` against a pinned checkout of
  `cirsteve/shelly`. Analysis, Planning and all three Briefs are approved.
  The `theme-foundation` builder and assessor finished. Its PR
  is [#2](https://github.com/cirsteve/shelly/pull/2); the other cohorts depend
  on it and on each other. This run was launched with `admission: true` and
  needed a separate Admit build review. New launches from the v1 form use
  `admission: false`, so accepting the Briefs starts the first eligible
  builder. The older seed `run-9e88f4b61c072a35`
  remains unsuitable for full-flow assessment because it has no repository.
  The default install needs its database cutover before this PWA branch can
  run against it.
- **The shadow's backend publication key remains readable by same-user agent
  processes.** `scripts/oakridge-shadow` stores it beside the agent workdir and
  starts both the backend and agent under the same OS account. In the shared
  Brief session, an agent read that key instead of its task's session bearer:
  the bearer request was refused, then an unauthenticated retry was accepted as
  an operator revision and the worker failed with `no_output`. The task now
  repeats its session bearer and the loopback publish route requires explicit
  operator intent for an operator edit, so a missing bearer returns 401. These
  changes prevent accidental misattribution; they do not isolate the backend
  key from an agent running under the same account. A separate process/account
  boundary is still needed for that isolation.
- **The shadow backend cannot observe GitHub PR state without credentials.**
  The current `127.0.0.1:8800` process has no GitHub token; a later
  `pull_request.observe` step will report `discovery_unsupported`. Provide
  credentials to the shadow backend before using this run to assess merge
  confirmation or end-to-end completion.
- **The development PR artifact can claim a PR exists with an empty URL.** In
  `run-072ecbd42a8f7169`, the builder could not reach gated-review from its
  own session and published `pr_url: ""`. The `pr_body` schema accepted it, so
  `pr_watch` started and failed `invalid_instruction` because
  `pull_request.observe` requires a nonempty URL. The branch and PR were later
  published through the gated-review connection and an operator revision
  corrected the `pr` artifact, but the watcher retains its failed attempt.
  The pinned workflow needs a nonempty-URL guard or validation so an absent PR
  cannot start observation or masquerade as a successful PR publication.
- **The first shadow Cohort assessment predates PR recovery.** The assessor
  reviewed the builder's original empty-URL `pr` artifact and published a
  `fail` verdict because no PR existed then. It also found that dark calendar
  day numbers are effectively invisible in this intentionally partial Cohort 1
  state and that the builder did not disclose that seam. PR #2 and the corrected
  `pr` revision arrived after the assessor started, so its historical verdict
  remains valid for what it reviewed; an operator must review it with that
  timing in mind. The current gated-review tool set cannot amend the PR body,
  which still lacks the brief's required contrast figures and deferred-defect
  disclosure.
- **Opaque v1 artifact IDs with no v2 revision identity cannot be resolved.**
  A composite v2 ID resolves on a cold load, and the client can find a bare v2
  revision ID by searching run and unit views. An arbitrary retired v1 UUID
  has no corresponding key in the v2 read contract and returns a clear
  not-found error. An opaque gate ID similarly resolves only when its supplied
  revision and action identify one current v2 review decision.
- **Several frozen v1 controls have no corresponding v2 command.** V2 has no
  thread ping/resolution or review-item update endpoint. These client methods
  fail explicitly. V2 does expose `DELETE /runs/:run_id`, but deletion is not
  wired in the adapter because the operator chose Cancel and Archive instead.
  The v1 workflow graph cannot be submitted as a v2 workflow definition without
  a model translation; the v2 definition API itself exists. The workflow
  definition detail currently shows a placeholder graph because the v1 editor's
  graph model does not represent a v2 bundle.
- **Final merge response metadata has no v2 equivalent.**
  `confirmFinalPullRequest` submits the v2 `confirm_merged` decision and then
  returns a minimal compatibility `EpicWorkflowProfile` to satisfy its frozen
  v1 signature. Its profile fields are placeholders; the run detail does not
  expose a profile from v2. The decision's committed result is the authority.
- **The frozen Activity pane has only the v2 events with a truthful v1
  equivalent.** The kbbl proxy serves its retired `/run_events` read from
  paginated v2 per-unit history, so publications and review decisions render
  without changing the pane. V2 does not record separate `gate_opened` or
  `pull_request_observed` events, so the compatibility feed cannot show those
  v1 rows. Each Activity refresh currently reads every unit's history; this
  should be measured on long runs before setting a shorter polling interval.

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
