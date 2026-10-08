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
polls or leases. `src/workflows/topology.ts` declares three generic workflows
that interpret every pinned bundle without knowing its stages:

- `oakridgeRunWorkflow` (id `run:<run_id>`) — on each wake re-reads the
  authority, delivers configured lifecycle triggers, retries deferred evidence
  and starts workflows for intents that need one; exits when the root scope is
  terminal and nothing is owed. Every accepted command sends it a wake.
- `oakridgeEffectWorkflow` (id = start intent id) — carries one committed start
  to its provider with capped backoff, observes until terminal, persists the
  result and delivers evidence.
- `oakridgeCleanupWorkflow` (id = stop intent id) — carries one committed stop
  until the provider positively acknowledges it.

Steps are IO boundaries (one DB write, one core call, one provider call). A
crash mid-step resumes at that step on the next process of the same application
version. A clean shutdown parks running workflows (DBOS cancel) and the next
boot resumes them. An `ERROR` run is forked at its failed step into the next
generation; a long run rolls over after 128 iterations with its scan cursor.
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
rollbacks; a different version does not resume workflows pinned to the old one.

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
