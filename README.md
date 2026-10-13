# oakridge

Oakridge runs pinned workflow definitions for agent-driven software work. The
Rust `workflow-core/` library compiles workflows and steps runs without
external IO. `oakridge-dbos/` is the single writer: it owns durable event
ingress, effect dispatch, recovery and read projections. DBOS
persists the workflow runtime. `kbbl/` provides the operator PWA and ACP
session adapter; its separate SQLite ledger owns only local sessions, turns
and process observations.

## Layout

- `workflow-core/` — Rust model, compiler, evaluator and CLI.
- `oakridge-dbos/` — TypeScript durable run authority and HTTP API.
- `workflow-config/` — the development workflow, samples and prompts.
- `kbbl/` — operator PWA and interactive ACP sessions.
- `legit-biz-club/` — independent workspace collaboration library.
- `lbc-dashboard/` — read-only dashboard for the workspace library.

Workflow names, stages, workers and reviews come from the pinned definition.
The evaluator has no workflow-specific branch. A successful decision or
publication response is the committed event: `{kind: "committed", run_id,
event_id}`.

## Development

```bash
bun install --frozen-lockfile
cargo build --locked --manifest-path workflow-core/Cargo.toml -p workflow-cli
bash scripts/generate-core-contracts.sh --check
bun workflow-config/src/generate.ts --check
bun run typecheck
bun run --filter kbbl test
bun run --filter kbbl test:pwa
bun run --filter oakridge-dbos test:unit
```

The DBOS integration suite requires `OAKRIDGE_TEST_DATABASE_URL` pointing to a
PostgreSQL 15+ instance with permission to create and drop test databases. Run
`bun run --filter oakridge-dbos test:integration` after building the Rust CLI.
It boots the production composition against fresh databases and drives the
shipped bundles through provider operations. The real-agent ACP smoke
test requires `KBBL_ACP_REAL_AGENT` and is reported as skipped by the normal
kbbl test command when no real agent is configured.

For local startup, run `./scripts/oakridge-start` from the repository root. It
rebuilds the Rust WASM module (a no-op when it is current; it stops if cargo is
missing, and an explicit `OAKRIDGE_CORE_WASM` is used as given), starts PostgreSQL through Docker when
`DBOS_SYSTEM_DATABASE_URL` is unset, applies the authority baseline, and starts
the DBOS backend and kbbl PWA. The baseline can be applied again when its
recorded digest matches; a changed baseline file stops startup and reports both
digests. Startup verifies the encryption key and existing intents, registers
the provider and workflow services, launches DBOS, resumes active runs and
parked effects, and only then binds HTTP. Set `OAKRIDGE_PROMPT_ROOT` to the repository root when launching the
backend separately so it can read prompt files under `workflow-config/prompts/`
when a definition is first pinned; runs render from the stored copy.
`OAKRIDGE_GITHUB_TOKEN` (or `GITHUB_TOKEN`) authenticates pull request
observation. The DBOS application version defaults to a 16-character SHA-256
digest combining the sorted `ENGINE_SOURCE_MANIFEST` source digest, the
`0001_core.sql` baseline digest and the digest of the core binary it
spawns (see `oakridge-dbos/README.md`).
Bundle, route, projection, prompt and UI edits do not change it; set
`DBOS_APPLICATION_VERSION` only to pin it for a controlled fork or rollback.

Edit the examples in `workflow-config/samples/`. Their YAML is parsed into
the Rust test fixtures by `workflow-config/src/generate.ts`; CI checks that
the committed JSON matches. Definitions are authored as workflow JSON in the
PWA's definition editor; `POST /api/definitions/compile` checks a draft against
the Rust compiler before it is saved.

Each selected action has a pinned `deadline_ms` that bounds an individual
provider call. A DBOS execution timeout also bounds the entire start and
observation workflow; an expired parked effect is settled as rejected on
recovery. A clean stop parks workflows for the next boot. Infrastructure
errors in the run loop fork a successor from the failed step; periodic
rollover preserves its scan cursor and run generation. Provider failures
become declared evidence and follow the pinned bundle's failure policy.

## Database cutover

1. Stop the Oakridge service.
2. Run `pg_dump` to a file nothing in this repository reads.
3. Drop and recreate the Oakridge database empty.
4. Deploy the new stack: Rust CLI, DBOS backend and kbbl PWA.
5. Admit traffic after the new stack is healthy.

The kbbl SQLite ACP ledger is separate. It is also created fresh at cutover:
its schema is a single baseline migration with workflow identity columns.

## Agent context

Per-package `CLAUDE.md` and `AGENTS.md` files are generated from `.catagents/`
sources. Rebuild them with `catagents` when that tool is available.
