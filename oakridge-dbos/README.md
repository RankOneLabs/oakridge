# Oakridge DBOS backend

The TypeScript backend owns durable workflow state. `src/main.ts` applies the
authority baseline under a PostgreSQL advisory lock, then starts the production
composition. The composition loads the Rust core as in-process WASM, opens the
database through `src/storage/database.ts`, registers the workflow services,
launches DBOS, and resumes runs that still need work. Only after this succeeds
does `main.ts` bind HTTP; a failed stage closes the resources it started.

`src/storage/commit.ts` is the single writer of workflow state: under the run
row lock it steps the core over a step snapshot and writes the event with its
writer, the state delta, an effect instruction for each newly wanted worker, the
wanted log, the ingress receipt and the operator event, in one transaction. DBOS
carries effect instructions to providers, and projections read committed state.

## Runtime

DBOS (`@dbos-inc/dbos-sdk`) is the execution runtime; nothing in this package
polls or leases. `src/workflows/topology.ts` declares three generic workflows
that carry every run without knowing its stages:

- `oakridgeRunWorkflow` (id `run:<run_id>`, then `run:<run_id>:<n>`) — on each
  wake re-reads the run's owed intents and starts a carrier for each; exits when
  the run is done or cancelled and nothing is owed. Every committed event wakes it.
  With pinned DBOS SDK 4.25.14, `DBOS.send` stores a wake until `DBOS.recv`
  consumes it, even when the send arrives during carrier dispatch before the
  run parks. `tests/periodic-workers.test.ts` holds that ordering open and
  checks the run advances before its wake timeout. Recheck this guarantee on
  an SDK upgrade; without it, a pre-park wake could delay work until timeout.
- `oakridgeEffectWorkflow` (id = `<intent id>@<application version>`, then
  `…:<n>`) — carries
  one effect instruction, reports what happened to commit with the executor as
  writer, and settles the intent `stopped` or `failed`:
  - an **agent** worker runs in a kbbl resumable session. The carrier renders
    the attempt's task once, in a checkpointed step, claims a start try,
    ensures the session (`PUT /sessions/resumable/:key`, with the revive header
    so an ended session comes back), reports `WorkerStarted` with the session
    and the hash of its publication secret, then delivers the task as the
    session's input keyed by the action id. Re-sending that input returns its
    receipt, which is how the turn is observed; its end is `WorkerEnded`.
  - a **code** worker runs a registered operation (`src/operations/`): the
    carrier reports `WorkerStarted`, runs it (one-shot transient failures use
    the start budget; a watch retries and rolls over across a longer outage),
    publishes its value as `RevisionPublished` by the action,
    and reports `WorkerEnded`. With `every` it repeats while the intent is live,
    each run a later attempt of the same action.
- `oakridgeCleanupWorkflow` (id = `<intent id>:stop@<application version>`,
  then `…:<n>`) — carries one requested stop until kbbl confirms it
  (`DELETE /sessions/:sid`). A fresh session is fenced; a resumed one is
  closed, so a later attempt can revive it. A start never claimed never reached
  kbbl, so its stop settles without calling it. A stop commit requested
  (`stop_origin = commit`) ends the attempt as `attempt_stopped`, unless its
  start carrier already reported the end (a turn that finished just as its
  unit went inactive); one the executor requested has already reported how its
  attempt ended. Commit keeps the first end of an attempt; a later one is
  refused, and logged only if the attempt has not ended.

An operator review awaiting a decision has its prompt rendered by commit,
from the inputs `step` resolved for it, and kept on its unit
(`unit.review_prompts`), so the inbox reads it without calling the core.

### Agent sessions

`session: resume` (the default) keys the kbbl session on unit and worker, so a
revise continues the conversation; `session: fresh` keys it on the action, and
a fresh attempt with history starts with a handoff block (the latest revision
of each artifact it creates, the review form's feedback that caused it, how
the previous attempt ended), worded by `prompts.handoff` when the worker
declares one. Discussion threads are for people and never reach an agent. A session starts with a preamble that carries its publication
block: each created artifact's endpoint and schema, and the session's secret.
Everything in the preamble is fixed for the session, so every attempt's ensure
sends the same spec. The secret is an HMAC of the session key under
`OAKRIDGE_PUBLICATION_KEY`; only its hash is stored, on the attempt.

Configuration (read by `src/main.ts`):

- `KBBL_BASE_URL` — the kbbl agents run in. Unset, every agent attempt fails
  with `kbbl_unconfigured`.
- `KBBL_CONTROL_TOKEN` — kbbl's control token, sent as Bearer on every
  executor call to kbbl; defaults to `OAKRIDGE_CONTROL_TOKEN`. kbbl refuses an
  unauthenticated write whenever it has a token.
- `OAKRIDGE_PUBLICATION_KEY` — required with `KBBL_BASE_URL`. Rotating it
  does not revoke secrets already handed out: publish resolves a secret by the
  hash its attempt stored, so an old secret keeps working while its session
  has a running attempt. To revoke, stop the sessions. Rotating it also breaks
  every `resume` session started under the old key, whose next ensure sends a
  different preamble that kbbl refuses as a spec conflict, so rotate only when
  no run has agent sessions in progress.
- `OAKRIDGE_PUBLIC_URL` — this backend as agents reach it (default
  `http://<host>:<port>`). Agents publish to it directly: the kbbl proxy does
  not forward their secret.
- `OAKRIDGE_AGENT_WORKDIR` — where a `workspace: none` session runs (default
  `<tmpdir>/oakridge-agent-workdir`). kbbl cuts every session a worktree, so
  boot makes it an empty repository with one commit. A `repository(...)` workspace runs in a
  worktree of the prepared repository, branched from its prepared head.
- `OAKRIDGE_GATED_REVIEW_URL` — the gated-review MCP endpoint used by `pull_request.observe`. `scripts/oakridge-start` sets it from the `gated-review` server in the repository's `.mcp.json`; set it by hand only when starting the backend separately. Unset, observation fails with `discovery_unsupported`. The server must expose the expanded `pr_status` result.

Steps are IO boundaries (one DB write, one core call, one provider call). A
crash mid-step resumes at that step on the next process of the same application
version. A clean shutdown parks running workflows (DBOS cancel), and the next
boot of the same version resumes them. A boot of a different version carries
them over instead (see Application version). An `ERROR` run is forked at its
failed step into the next generation, and a long run rolls over after 128
iterations. Carriers roll over the same way after `carrier_max_iterations`
(default 128) observations, watch runs or stop tries. The authority stores no
generation: a run's or carrier's current generation is the newest workflow DBOS
holds for it. A start carrier that finished while its intent is still owed ends
the attempt as `carrier_ended` (stopping any session it may have opened); a stop
carrier that finished unconfirmed is carried again by its next generation.

Each provider call is bounded by its instruction's `deadline_ms`, and starts by
its `max_start_attempts`; a lost session is bounded by consecutive observations
that get no answer (unavailable or unreachable), so a working agent session has
no wall-clock limit. A session silent past its bound is stopped, not just failed,
so a later revise does not find it busy.
`execution_deadline_ms` in the workflow timing optionally adds a DBOS execution
timeout; if that deadline expires while parked, startup fails the attempt.

### Application version

DBOS resumes only workflows recorded under the running `applicationVersion`.
`src/workflows/engine-version.ts` hashes the sorted `ENGINE_SOURCE_MANIFEST`
paths and bytes, then combines that source digest with the SHA-256 digest of
`src/storage/migrations/0001_core.sql` and of the WASM module
the process loads. The final SHA-256 is truncated to 16 hex characters. This
includes workflow dependencies, the authority schema baseline and the Rust
evaluator build. Bundle, route, projection, prompt and UI changes leave it
unchanged. `DBOS_APPLICATION_VERSION` overrides it for controlled forks and
rollbacks.

DBOS never runs a workflow recorded under another version, so boot carries
them over instead of resuming them. Live workflows of another version are
cancelled to fence any process still running it. A run whose current
generation belongs to another version gets a fresh generation that rereads the
authority. Intent workflows are addressed per version, so
the run's next recheck starts this version's carrier for any intent still owed.
The older rows remain as history. A carried effect starts a fresh DBOS
execution deadline.

## Storage records

`src/storage/migrations/0001_core.sql` is the only hand-written
description of the authority tables. `scripts/generate-storage-records.ts`
applies it to a scratch database on `OAKRIDGE_TEST_DATABASE_URL`'s server and
runs [kysely-codegen](https://github.com/RobinBlomberg/kysely-codegen) over the
result, writing `src/storage/db-types.ts`, the `DB` interface every query is
typed by. Each jsonb column names its TypeScript type with a
`COMMENT ON COLUMN ... IS '@type {Name}'`, resolved in
`src/storage/json-column-types.ts`; jsonb writes go through `jsonText`, which
keeps that type. `src/storage/schema-records.ts` adds only the id brands. After
editing the baseline, run `bun run generate:records`; CI fails when the
committed file differs.

Queries are Kysely queries and live in `src/storage/`: `commit.ts`,
`snapshot-store.ts`, `read-store.ts`, `executor-store.ts`, `registry-store.ts`,
`collaboration-store.ts`, `run-deletion.ts` and `migrate.ts`.
`tests/storage-boundaries.test.ts` fails the build on raw SQL, on a query
outside `storage/`, or on a write to workflow-state tables outside commit and
the stores sanctioned for it.

## Verify

From the repository root:

```bash
cargo build --locked --manifest-path workflow-core/Cargo.toml --target wasm32-unknown-unknown -p workflow-evaluator
bunx tsc --noEmit -p oakridge-dbos/tsconfig.json
bun run --filter oakridge-dbos test:unit
bun run --filter oakridge-dbos test:integration
```

`tests/executor-e2e.test.ts` and `tests/executor-restart.test.ts` drive the
samples end to end against a stub kbbl (`tests/stub-kbbl.ts`). Sample A against
a real kbbl and agent is opt-in, since it spends agent turns: start a kbbl of
your own on another port and data directory, then run
`OAKRIDGE_REAL_KBBL_URL=http://127.0.0.1:<port> bun test --timeout=1500000 tests/real-agent.smoke.test.ts`.

The integration tests require `OAKRIDGE_TEST_DATABASE_URL` for PostgreSQL 15+
with create/drop database permission; each test file creates and drops its own
scratch database. Point it at a server of its own, never at a live one.

## Database cutover

The authority baseline requires PostgreSQL 15 or newer. Repeating start against
the same baseline succeeds; a changed baseline file is rejected with both
digests. DBOS system tables may exist before the authority baseline is applied.

Effect instructions carry no secret, so they are stored unsealed. Set
`OAKRIDGE_ALLOWED_ORIGINS` to a comma-separated list of exact browser origins
that may write; loopback origins need an explicit entry. Writes require
`application/json`. The backend and kbbl proxy accept the same operator token
as Bearer or through kbbl's HttpOnly control cookie; the proxy keeps the cookie
local and forwards the verified token to the backend. With no token on a
loopback bind, the backend answers only requests whose `Host` names loopback
(`localhost`, `127.0.0.0/8`, `[::1]`), so a DNS-rebound page cannot read it;
kbbl's proxy addresses it by its loopback URL.

Stop the service; run `pg_dump` to a file nothing in this repository reads;
drop and recreate the Oakridge database empty; deploy the core WASM, DBOS
backend and kbbl PWA; then admit traffic. kbbl's SQLite ACP ledger is separate.
