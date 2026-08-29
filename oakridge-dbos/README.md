# Oakridge DBOS backend

TypeScript replacement for the custom Oakridge v2 Rust orchestration
substrate. DBOS owns workflow execution, durable waits, fan-out/fan-in,
recovery, and workflow history. Oakridge owns workflow definitions, stage and
artifact contracts, review policy, executor adapters, and operator read models.

## Run locally

The normal entry point is the repository-level launcher:

```bash
bun run oakridge
```

It manages local PostgreSQL when needed, applies migrations, and supervises this
backend with kbbl. Use the commands below only when running the backend
separately for debugging.

The backend and DBOS use the same PostgreSQL database. Oakridge tables live in
the `oakridge` schema; DBOS manages its own system schema.

```bash
export DBOS_SYSTEM_DATABASE_URL=postgres://oakridge:oakridge@localhost:5432/oakridge
export DBOS_APPLICATION_VERSION="$(git rev-parse HEAD)"
export KBBL_BASE_URL=http://127.0.0.1:8788
export OAKRIDGE_DBOS_HOST=127.0.0.1
export PORT=8790

bun run migrate
bun run start
```

## V2 clean cutover

The run-record topology is the only supported topology. For the first v2
deployment, stop every old Oakridge/DBOS worker, archive evidence needed
outside the service, recreate the Oakridge application database, run every
numbered migration from zero, and seed the built-in definitions by starting
the backend. Use a new `DBOS_APPLICATION_VERSION` for this cutover.

There is deliberately no adoption or backfill path. Startup refuses a database
containing legacy workflow-attempt identities or attempt-owned stages rather
than silently treating them as v2 runs. A healthy v2 database can be restarted
in place: v2 attempts use the `v2-run:` namespace and stages are owned directly
by the run record. Migration `0016` creates the database-owned work-order
capability seed; operators do not provision that secret externally.

Changed artifact content creates a new immutable revision and supersedes the
prior unreleased revision. Executors can withdraw the current unreleased
revision with `POST /artifacts/:artifact_id/withdraw`; released revisions
require a run-owned retry instead.

`DBOS_APPLICATION_VERSION` is intentionally required. Do not reuse a version
after changing durable workflow-operation order.

## Verify

```bash
bun test
bun run typecheck
```

The production entry point is `src/main.ts`. Operational guidance is in
`../docs/oakridge-v2-runbook.md`.
