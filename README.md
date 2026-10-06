# oakridge

Oakridge runs pinned scope definitions for agent-driven software work. The
Rust `workflow-core/` library compiles and evaluates definitions without
external IO. `oakridge-dbos/` owns durable command and publication ingress,
mutation receipts, effect dispatch, recovery and read projections. DBOS
persists the workflow runtime. `kbbl/` provides the operator PWA and ACP
session adapter; its separate SQLite ledger owns only local sessions, turns
and process observations.

## Layout

- `workflow-core/` — Rust model, compiler, evaluator and CLI.
- `oakridge-dbos/` — TypeScript durable scope authority and HTTP API.
- `workflow-config/` — example bundles and prompts.
- `kbbl/` — operator PWA and interactive ACP sessions.
- `legit-biz-club/` — independent workspace collaboration library.
- `lbc-dashboard/` — read-only dashboard for the workspace library.

Workflow names, stages, commands and review paths come from the pinned bundle.
The interpreter has no workflow-specific branch. A successful command or
publication response includes a durable receipt; an unsupported legacy
workspace event returns an explicit failure.

## Development

```bash
bun install --frozen-lockfile
cargo build --locked --manifest-path workflow-core/Cargo.toml -p workflow-cli
bun run typecheck
bun run --filter kbbl test
bun run --filter kbbl test:pwa
bun run --filter oakridge-dbos test:unit
```

The DBOS integration suite requires `OAKRIDGE_TEST_DATABASE_URL` pointing to a
PostgreSQL instance with permission to create and drop test databases. The
cold-boot test creates an empty database, starts the production composition and
checks a committed decision through the full stack. The real-agent ACP smoke
test requires `KBBL_ACP_REAL_AGENT` and is reported as skipped by the normal
kbbl test command when no real agent is configured.

For local startup, build the Rust CLI and set `DBOS_SYSTEM_DATABASE_URL` and
`OAKRIDGE_CORE_BINARY` for `bun run --filter oakridge-dbos start`. Set
`OAKRIDGE_CORE_BASE_URL` on kbbl to expose the backend through the same-origin
operator proxy.

## Database cutover

1. Stop the Oakridge service.
2. Run `pg_dump` to a file nothing in this repository reads.
3. Drop and recreate the Oakridge database empty.
4. Deploy the new stack: Rust CLI, DBOS backend and kbbl PWA.
5. Admit traffic after the new stack is healthy.

The kbbl SQLite ACP ledger is separate and remains in place.

## Agent context

Per-package `CLAUDE.md` and `AGENTS.md` files are generated from `.catagents/`
sources. Rebuild them with `catagents` when that tool is available.
