# Live verification records

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
