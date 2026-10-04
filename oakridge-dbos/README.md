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

## V15 clean cutover

V15 uses the checked cohort decision trees, worker-owned output acceptance and
immutable stage membership. Repository identity is frozen on each cohort;
selected execution intents carry their prompts, settings and typed inputs.
The compiled prompt bundle stores stage/worker/action entries directly.

Stop the old backend and DBOS workers, archive any run evidence to retain,
create a fresh application database, apply every numbered migration and start
the backend to seed the built-in v15 definition. Migration `0018` refuses
nonempty run or prompt ledgers. Startup checks the completed schema and never resets it.
There is no old-run adoption or conversion path. Use a new
`DBOS_APPLICATION_VERSION`; restart a migrated v15 database in place using
its existing application version to recover active workflows.

## Verify

```bash
bun run test:unit
bun run test:acceptance
bun run typecheck
bun run validate:definitions
```

The acceptance command builds the kbbl PWA, runs Chromium UI checks and
exercises real PostgreSQL, Git, kbbl ACP workers and backend process crash
recovery. The S1–S22 replacement mapping and removal ledger are in
[`docs/v15-contracts/README.md`](../docs/v15-contracts/README.md).

The production entry point is `src/main.ts`. Operational guidance is in
`../docs/oakridge-v2-runbook.md`.
