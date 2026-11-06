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

`gated-review.json` records the actual role tool lists and the live server's
HTTP 200 response to a deliberately invalid bearer. Role credentials cannot
be issued by the checked-out server: it scopes sessions by endpoint path and
has no bearer validator or issuer. This is failed authentication evidence,
not a passing credential check. The gated smoke test keeps requiring issued
`GATED_REVIEW_BUILDER_TOKEN` and `GATED_REVIEW_ASSESSOR_TOKEN` and refuses to
substitute invented credentials.

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
