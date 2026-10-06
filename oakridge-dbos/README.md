# Oakridge DBOS backend

The TypeScript backend owns durable scope authority. `src/main.ts` starts the
production composition: the Rust CLI evaluates pinned definitions, the mutation
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
The version is the digest of `src/workflows/` (`engine-version.ts`), so it
moves exactly when the workflow functions change — not for a bundle, route,
projection or UI change. `DBOS_APPLICATION_VERSION` overrides it for forks and
rollbacks; bumping it parks in-flight workflows until they are forked by hand.

## Verify

From the repository root:

```bash
bun run --filter oakridge-dbos verify
```

The integration tests require `OAKRIDGE_TEST_DATABASE_URL` with create/drop
database permission. `tests/fresh-boot.test.ts` creates an empty database and
checks the production stack through an HTTP decision and read projection.

## Database cutover

Stop the service; run `pg_dump` to a file nothing in this repository reads;
drop and recreate the Oakridge database empty; deploy the Rust CLI, DBOS
backend and kbbl PWA; then admit traffic. kbbl's SQLite ACP ledger is separate.
