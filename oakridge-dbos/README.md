# Oakridge DBOS backend

The TypeScript backend owns durable scope authority. `src/main.ts` starts the
production composition after applying the authority baseline under a PostgreSQL
advisory lock. It then launches DBOS and binds HTTP; a failed stage closes the
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
crash mid-step resumes at that step on the next process. A clean shutdown parks
running workflows (DBOS cancel) and the next boot resumes them.

### Application version

DBOS resumes only workflows recorded under the running `applicationVersion`.
The version is the digest of `ENGINE_SOURCE_MANIFEST` in
`src/workflows/engine-version.ts`, covering workflow functions and their
runtime dependencies. Bundle, route, projection, prompt and UI changes leave
it unchanged. `DBOS_APPLICATION_VERSION` overrides it for forks and rollbacks;
bumping it parks in-flight workflows until they are forked by hand.

## Verify

From the repository root:

```bash
cargo build --locked --manifest-path workflow-core/Cargo.toml -p workflow-cli
bun run typecheck
bun run --filter oakridge-dbos test:unit
```

The integration tests require `OAKRIDGE_TEST_DATABASE_URL` with create/drop
database permission. `tests/fresh-boot.test.ts` creates an empty database and
checks the production stack through an HTTP decision and read projection.

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
