# Active known issues

This document tracks reproducible issues in the current Rust evaluator, DBOS
authority, provider composition and operator PWA. For each new issue, record
the affected version or bundle, a reproduction, observed behavior, and the
expected behavior. Move an entry out of active issues when its fix is verified.

No active issues are recorded.

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
