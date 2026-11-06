# Live verification records

The prepared `pr.json` and `build_result.json` are artifact bodies awaiting
republication. The original task secret was refused with HTTP 401 after its
builder attempt had already succeeded. No PR artifact revision was recorded,
so the build result was not sent out of order. A current task credential is
required; these files contain no credentials.

The verified source run is `run-5ca31bc6c2414610`; `latest.json` locates its
committed capture, original authority rows and HTTP readback report. Real
TypeSafe execution `9bdc9b8d-9c7b-4065-b663-7b35a56adae6` answered
`traceable` (confidence 0.88): probabilities 0.92 traceable, 0.04 unsupported,
0.04 unclear_insufficient_evidence. The report retains the question, evidence,
evaluator, execution, raw answer and provider attempt metadata obtained from
authenticated HTTP response bodies. The provider returned no request ID;
the stored attempt records that absence as null, alongside its actual local
job ID, attempt, completed status and admitted cost estimate.

`gated-review.json` records the configured endpoint's actual `tools/list`
response and timestamp. The agent tool list excludes `merge_pr` and
`mark_merge_ready`; merging remains an operator action. Regenerate the record
with `OAKRIDGE_GATED_REVIEW_URL` set and `bun run test:acp:gated-review:real`
in kbbl. The explicit live command fails if the endpoint is unset or unreachable.

For cohort `workflow-gated-review`, AC09's requirement that `flatten` and
`distinct` exist in the generated contracts is vacuous: those contracts carry
expression source as strings and contain no expression builtin variants.
`workflow-core/crates/contracts/src/lib.rs` generates the core and source
contracts from the protocol and authored workflow schemas; the operator
contracts likewise expose expression strings. The builtin behavior is proved
by the Rust compiler tests in `r5_constructs.rs` and evaluator tests in
`collections.rs`. Contract generation checks prove the generated files remain
in sync with their source schemas.

If AC09 is reused, use: "`flatten` and `distinct` exist in the Rust model,
compiler and evaluator. Compiler tests cover wrong argument types, including
`flatten` on a list that is not a list of lists. Evaluator tests cover nested,
empty and duplicate lists, and show `distinct` keeps first-occurrence order.
Generated contract checks report no drift."

Launch an isolated source run with the installed Codex ACP agent's ordinary
authentication and `OAKRIDGE_TEST_DATABASE_URL`:

```sh
bun oakridge-dbos/scripts/live-source-run.ts --input input.json \
  --output observation/verification --through brief
```

`input.json` has the committed development workflow's input shape. Its
repository must have an existing remote build base. Preparation and per-agent
base refreshes use gated-review's `git.fetch`; no source-run helper runs a
remote git shell command. Agents run through the production ACP service and
session handlers, in separate local worktrees. Planning reviews are accepted
only within this fresh run. `--through assessment` also accepts brief reviews
and permits the input's actual build, stopping before assessment approval or
integration. The selected run is canceled after its target artifact arrives.

Each new directory retains `run.json`, the exact ordered production
`SourceEventDelivery[]` in `capture.json`, `inspect.json`, the selected run's
actual `authority-rows.json`, and a `complete.json` marker. Both fresh databases
remain available; their names are recorded, without connection secrets. The
isolated ACP ledger and worktrees are retained locally under ignored `agents/`.
An interrupted or failed run retains its partial capture and latest inspect
response without claiming completion. `/tmp` is refused as an output root.

With `TYPESAFE_API_KEY` and `OAKRIDGE_TEST_DATABASE_URL` in the environment:

```sh
bun observation/scripts/jev-live-walkthrough.ts \
  --capture observation/verification/<directory>/capture.json \
  --question plan.criterion_traceability --estimated-cost 0.01 \
  --report observation/verification/<directory>/grade.json
```

This creates another empty database, ingests the exact capture through the
authenticated API, derives evidence at queue admission and calls the real
direct adapter. The report contains the execution ID, raw answer,
probabilities and records read from authenticated HTTP response bodies.
Question versions use `GET /v1/questions/:id/versions/:version`; evidence
sets use `GET /v1/evidence-sets/:id`. These routes require read authority and
scope every lookup to its credential's producer and namespace.

A later run can start after an existing namespace cursor. Its recorded
starting cursor seeds only the new verification namespace; the original
deliveries remain unchanged, and gaps or backwards positions are refused.
Subject selection pages through the eligibility API for the captured revision,
skipping uncited or unlinked criteria before any provider call. Grade readback
also follows every result page.

`--resume-database observation_jev_live_<16 hex digits>` resumes a retained
verification database after a readback interruption. Every captured revision
is compared to its stored HTTP response before selecting the exact provider
evaluation identity. Re-enqueueing the same terminal job is idempotent and
does not send a second provider request. Other human grades on the criterion
remain visible. Execution timestamps are compared as UTC instants, retaining
all other field comparisons.

Regenerate the run slice only from a completed grade report for the exact
capture, with an assessment included (`--through assessment`):

```sh
bun observation/scripts/regenerate-live-fixtures.ts \
  --capture observation/verification/<directory>/capture.json \
  --rows observation/verification/<directory>/authority-rows.json \
  --grade observation/verification/<directory>/grade.json
```

The command replaces published bodies without editing them, retains the
original v2 provenance, re-derives the nine hand-written failure-case
references and records the source run and execution in `PROVENANCE.md`.
