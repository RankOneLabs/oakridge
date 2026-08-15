# Oakridge DBOS backend

TypeScript replacement for the custom Oakridge v2 Rust orchestration
substrate. DBOS owns workflow execution, durable waits, fan-out/fan-in,
recovery, and workflow history. Oakridge owns workflow definitions, stage and
artifact contracts, review policy, executor adapters, and operator read models.

## Run locally

The backend and DBOS use the same PostgreSQL database. Oakridge tables live in
the `oakridge` schema; DBOS manages its own system schema.

```bash
export DBOS_SYSTEM_DATABASE_URL=postgres://oakridge:oakridge@localhost:5432/oakridge
export DBOS_APPLICATION_VERSION="$(git rev-parse HEAD)"
export KBBL_BASE_URL=http://127.0.0.1:3000

bun run migrate
bun run start
```

`DBOS_APPLICATION_VERSION` is intentionally required. Do not reuse a version
after changing durable workflow-operation order. Keep executors for older
versions running until `/application_versions` shows that their gated work has
drained, or use an explicitly reviewed DBOS patch.

## Verify

```bash
bun test
bun run typecheck
```

The production-topology harness is
`src/dev/run-production-topology-proof.ts`. Cutover still requires completing
that live PostgreSQL proof, the kbbl hard-kill exercise, and the workflow-version
drain exercise documented in `../comms/oakridge-dbos-backend-replacement-spec.md`.
