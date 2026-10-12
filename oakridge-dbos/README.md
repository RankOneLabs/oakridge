# Oakridge DBOS backend

The TypeScript backend owns durable workflow state. `src/main.ts` applies the
authority baseline under a PostgreSQL advisory lock, then starts the production
composition. The composition loads the Rust core as in-process WASM, opens the
database through `src/storage/database.ts`, registers the workflow services,
launches DBOS, and resumes runs that still need work. Only after this succeeds
does `main.ts` bind HTTP; a failed stage closes the resources it started.

`src/storage/commit.ts` is the single writer of workflow state: under the run
row lock it steps the core over a scoped snapshot and writes the event with its
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
- `oakridgeEffectWorkflow` (id = `<intent id>@<application version>`) — carries
  one effect instruction: claims a start try, calls the provider, reports
  `WorkerStarted` and `WorkerEnded` to commit with the executor as writer, and
  settles the intent `stopped` or `failed`.
- `oakridgeCleanupWorkflow` (id = `<intent id>@<application version>`) — carries
  one requested stop until the provider positively acknowledges it.

The production provider refuses every start with `provider_not_ported` until
the executor's agent and code worker paths land (rescue spec R3), so an attempt
fails visibly and its worker shows as stalled in the inspect view.

Steps are IO boundaries (one DB write, one core call, one provider call). A
crash mid-step resumes at that step on the next process of the same application
version. A clean shutdown parks running workflows (DBOS cancel), and the next
boot of the same version resumes them. A boot of a different version carries
them over instead (see Application version). An `ERROR` run is forked at its
failed step into the next generation, and a long run rolls over after 128
iterations. The authority stores no generation: a run's current generation is
the newest run workflow DBOS holds for it.

Each provider call is bounded by its instruction's `deadline_ms`, and starts by
its `max_start_attempts`; a lost session is bounded by consecutive unavailable
observations, so a working agent session has no wall-clock limit.
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
local and forwards the verified token to the backend.

Stop the service; run `pg_dump` to a file nothing in this repository reads;
drop and recreate the Oakridge database empty; deploy the core WASM, DBOS
backend and kbbl PWA; then admit traffic. kbbl's SQLite ACP ledger is separate.
