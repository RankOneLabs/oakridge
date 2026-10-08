# Oakridge DBOS backend

The TypeScript backend owns durable scope authority. `src/main.ts` applies the
authority baseline under a PostgreSQL advisory lock, then starts the production
composition. The composition starts the Rust CLI, connects to PostgreSQL,
verifies the effect encryption key against stored intents, registers provider
and workflow services, launches DBOS, and resumes active runs and parked effects.
Only after this succeeds does `main.ts` bind HTTP; a failed stage closes the
resources it started. The Rust CLI evaluates pinned definitions, the mutation
service commits accepted decisions and receipts, DBOS drives effects and
recovery, and projections read committed state. Commands and publications use
run and scope identities; accepted writes return durable receipts.

## Runtime

DBOS (`@dbos-inc/dbos-sdk`) is the execution runtime; nothing in this package
leases external state. A run workflow waits on a bounded wake (`DBOS.recv`
with a timeout) rather than retrying a status check, and an effect workflow
sleeps a fixed interval between observations rather than polling a queue.
`src/workflows/topology.ts` declares three generic workflows that interpret
every pinned bundle without knowing its stages:

- `oakridgeRunWorkflow` (id `run:<run_id>`) — on each wake re-reads the
  authority, delivers configured lifecycle triggers, retries deferred evidence
  and starts workflows for intents that need one; exits when the root scope is
  terminal and nothing is owed. Every accepted command sends it a wake.
- `oakridgeEffectWorkflow` (id = `<start intent id>@<application version>`) — carries one committed start
  to its provider with capped backoff, observes until terminal, persists the
  result and delivers evidence.
- `oakridgeCleanupWorkflow` (id = `<stop intent id>@<application version>`) — carries one committed stop
  until the provider positively acknowledges it.

Most steps are one IO boundary (one DB write, one core call, one provider
call); the run's advance step is the exception, bundling a scope scan page,
an evidence delivery loop and several queries into one step, so a crash
mid-advance replays the whole page rather than resuming partway through it. A
crash mid-step otherwise resumes at that step on the next process of the same
application version. A clean shutdown parks running workflows (DBOS cancel).
The next boot of the same version resumes each affected run directly; a
parked effect or cleanup workflow it still owes is resumed lazily by that
run's own recheck rather than in one startup sweep, except one already past
its stamped execution deadline, which settles as expired instead. A boot of
a different version carries runs over instead (see Application version). An
`ERROR` run is forked at its failed step into the next generation; a long run
rolls over after 128 iterations with its scan cursor.
Child dispatch reads durable intent and workflow status, so restart neither
redelivers a settled child nor forgets one still pending.

Each provider start, observe and stop call uses its action's pinned
`deadline_ms`. Start and observation retries share a DBOS execution timeout
(one hour by default); if that deadline expires while parked, startup settles
the intent as rejected and delivers failure evidence. Cleanup remains pending
until the provider acknowledges it. Provider rejections and exhausted attempts
follow the bundle's declared recovery policy; infrastructure failures surface
as run workflow errors and are recovered through a fork.

### Application version

DBOS resumes only workflows recorded under the running `applicationVersion`.
`src/workflows/engine-version.ts` hashes the sorted `ENGINE_SOURCE_MANIFEST`
paths and bytes, then combines that source digest with the SHA-256 digest of
`src/storage/migrations/0001_core_authority.sql` and of the `OAKRIDGE_CORE_BINARY`
the process spawns. The final SHA-256 is truncated to 16 hex characters. This
includes workflow dependencies, the authority schema baseline and the Rust
evaluator build. Bundle, route, projection, prompt and UI changes leave it
unchanged. `DBOS_APPLICATION_VERSION` overrides it for controlled forks and
rollbacks.

DBOS never runs a workflow recorded under another version, so boot carries
them over instead of resuming them. Live workflows of another version are
cancelled to fence any process still running it. A run whose current
generation belongs to another version gets a fresh generation that rereads the
authority from its scan cursor. Intent workflows are addressed per version, so
the run's next recheck starts this version's carrier for any intent still owed,
under the next claimed dispatch generation rather than resuming the stale one.
The older rows remain as history. A carried effect keeps its original,
absolute execution deadline — stamped once into the authority row on first
dispatch and never refreshed — so a carry-over cannot extend how long an
intent is owed.

## Storage records

`src/storage/migrations/0001_core_authority.sql` is the only hand-written
description of the authority tables. `scripts/generate-storage-records.ts`
applies it to a scratch database on `OAKRIDGE_TEST_DATABASE_URL`'s server and
runs [pg-to-ts](https://github.com/danvk/pg-to-ts) over the result, writing
`src/storage/generated-records.ts`. Each jsonb column names its TypeScript type
with a `COMMENT ON COLUMN ... IS '@type {Name}'`, resolved in
`src/storage/json-column-types.ts`; status columns are Postgres enums, so their
unions are generated too. `src/storage/schema-records.ts` adds only the id
brands. After editing the baseline, run `bun run generate:records`; CI fails
when the committed file differs.

## Verify

From the repository root:

```bash
cargo build --locked --manifest-path workflow-core/Cargo.toml -p workflow-cli
bun run typecheck
bun run --filter oakridge-dbos test:unit
bun run --filter oakridge-dbos test:integration
```

The integration tests require `OAKRIDGE_TEST_DATABASE_URL` for PostgreSQL 15+
with create/drop database permission. The provider-driven bundle test uses
`createProductionComposition` and all shipped JSON definitions, and drives each
through repository preparation and the first analysis session against a stub
kbbl.

The core client caches compilation by an incremental content hash of the source
bundle. The compiler's `bundle_digest` is an output of that request, so it is
not available at cache lookup time. Snapshot reconstruction logs duration,
observation count, read roots, and witness rows for cost comparison.

## Database cutover

The authority baseline requires PostgreSQL 15 or newer. Repeating start against
the same baseline succeeds; a changed baseline file is rejected with both
digests. DBOS system tables may exist before the authority baseline is applied.

Set `OAKRIDGE_EFFECT_ENCRYPTION_KEY` to a generated 32-byte base64url key before
starting the service. Startup refuses a missing key or a key that cannot decrypt
existing effect intents. Keep this key stable across restarts. Set
`OAKRIDGE_ALLOWED_ORIGINS` to a comma-separated list of exact browser origins
that may write; loopback origins need an explicit entry. Writes require
`application/json`. The backend and kbbl proxy accept the same operator token
as Bearer or through kbbl's HttpOnly control cookie; the proxy keeps the cookie
local and forwards the verified token to the backend.

Stop the service; run `pg_dump` to a file nothing in this repository reads;
drop and recreate the Oakridge database empty; deploy the Rust CLI, DBOS
backend and kbbl PWA; then admit traffic. kbbl's SQLite ACP ledger is separate.
