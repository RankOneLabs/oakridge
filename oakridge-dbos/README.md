# Oakridge DBOS backend

TypeScript replacement for the custom Oakridge v2 Rust orchestration
substrate. DBOS owns workflow execution, durable waits, fan-out/fan-in,
recovery, and workflow history. Oakridge owns workflow definitions, stage and
artifact contracts, review policy, executor adapters, and operator read models.

The fixed v15 backend, migrations, loader and operational documentation have
been removed. The backend is intentionally unavailable until m3 authority;
`src/main.ts` is empty.

## Verify

From the repository root:

```bash
cargo build --locked --manifest-path workflow-core/Cargo.toml -p workflow-cli
bun run --filter oakridge-dbos test:unit
bun run typecheck
```
