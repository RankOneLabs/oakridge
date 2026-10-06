# Oakridge DBOS backend

The TypeScript backend owns durable scope authority. `src/main.ts` starts the
production composition: the Rust CLI evaluates pinned definitions, the mutation
service commits accepted decisions and receipts, DBOS drives effects and
recovery, and projections read committed state. Commands and publications use
run and scope identities; accepted writes return durable receipts.

## Verify

From the repository root:

```bash
cargo build --locked --manifest-path workflow-core/Cargo.toml -p workflow-cli
bun run --filter oakridge-dbos test:unit
bun run typecheck
```

The integration tests require `OAKRIDGE_TEST_DATABASE_URL` with create/drop
database permission. `tests/fresh-boot.test.ts` creates an empty database and
checks the production stack through an HTTP decision and read projection.

## Database cutover

Stop the service; run `pg_dump` to a file nothing in this repository reads;
drop and recreate the Oakridge database empty; deploy the Rust CLI, DBOS
backend and kbbl PWA; then admit traffic. kbbl's SQLite ACP ledger is separate.
