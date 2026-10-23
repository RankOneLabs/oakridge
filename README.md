# oakridge

Oakridge runs pinned workflow definitions for agent-driven software work. The
Rust `workflow-core/` library compiles workflows and steps runs without
external IO. `oakridge-dbos/` is the single writer: it owns durable event
ingress, effect dispatch, recovery and read projections. DBOS
persists the workflow runtime. `kbbl/` provides the operator PWA and ACP
session adapter; its separate SQLite ledger owns only local sessions, turns
and process observations.

## Layout

- `workflow-core/` — Rust model, compiler, evaluator (built to WASM) and contract generator.
- `oakridge-dbos/` — TypeScript durable run authority and HTTP API.
- `workflow-config/` — the development workflow, samples and prompts.
- `kbbl/` — operator PWA and interactive ACP sessions.

Workflow names, stages, workers and reviews come from the pinned definition.
The evaluator has no workflow-specific branch. A successful decision or
publication response is the committed event: `{kind: "committed", run_id,
event_id}`.

## Development

```bash
bun install --frozen-lockfile
cargo build --locked --target wasm32-unknown-unknown --manifest-path workflow-core/Cargo.toml -p workflow-evaluator
bash scripts/generate-core-contracts.sh --check
bun workflow-config/src/generate.ts --check
bun run typecheck
bun run --filter kbbl test
bun run --filter kbbl test:pwa
bun run --filter oakridge-dbos test:unit
```

The DBOS integration suite requires `OAKRIDGE_TEST_DATABASE_URL` pointing to a
PostgreSQL 15+ instance with permission to create and drop test databases. Run
`bun run --filter oakridge-dbos test:integration` after building the core WASM.
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
The gated-review endpoint is the `gated-review` server in the repository's `.mcp.json`; the launcher reads it and hands it to DBOS, for pull request observation, and to kbbl, for agent sessions. The endpoint must provide the expanded `pr_status` fields. The DBOS application version defaults to a 16-character SHA-256
digest combining the sorted `ENGINE_SOURCE_MANIFEST` source digest, the
`0001_core.sql` baseline digest and the digest of the core WASM module it
loads (see `oakridge-dbos/README.md`).
Bundle, route, projection, prompt and UI edits do not change it; set
`DBOS_APPLICATION_VERSION` only to pin it for a controlled fork or rollback.

To run a second Oakridge beside the one already running on a machine (an e2e
run next to the operator's own install), use `./scripts/oakridge-shadow` from
that checkout. It shares none of the default install's state: it starts its own
PostgreSQL container and volume, binds kbbl to 8798 and DBOS to 8800 on
loopback, keeps kbbl data, the agent workdir and a generated publication key
under `~/.local/state/oakridge-shadow`, and drops every `OAKRIDGE_*`, `DBOS_*`
and `KBBL_*` variable inherited from the shell. It refuses ports or a container
the default install uses. `OAKRIDGE_SHADOW_NAME`, `OAKRIDGE_SHADOW_*_PORT` and
`OAKRIDGE_SHADOW_STATE_DIR` run further instances; gated-review comes from the checkout's `.mcp.json`, as for the default install.
Its database starts with no projects; add them with `POST /api/projects` (see
the cutover below), each pointing at its own clone: a project whose `repo_dir`
is the default install's checkout would have shadow runs working in that
checkout.

Edit the examples in `workflow-config/samples/`. Their YAML is parsed into
the Rust test fixtures by `workflow-config/src/generate.ts`; CI checks that
the committed JSON matches. Definitions are authored as workflow JSON in the
PWA's definition editor; `POST /api/definitions/compile` checks a draft against
the Rust compiler before it is saved.

Each selected action has a pinned `deadline_ms` that bounds an individual
provider call. A DBOS execution timeout also bounds the entire start and
observation workflow; an expired parked effect is settled as rejected on
recovery. A clean stop parks workflows for the next boot. Infrastructure
errors in the run loop fork a successor from the failed step, and periodic
rollover starts the next generation. A provider failure fails its attempt;
the operator retries it.

## Database cutover

The v2 stack starts on an empty PostgreSQL database and an empty kbbl SQLite
ledger; nothing is migrated from v1. The v1 data was dumped beforehand and is
kept outside this repository.

1. Stop the Oakridge service, then drop and recreate its database empty. Move
   the kbbl data directory's database aside.
2. Remove the retired `compact`, `retention` and `runtime` keys from
   `kbbl/config.json`: its schema is strict, so kbbl refuses to start with them.
3. Deploy the new stack: core WASM, DBOS backend and kbbl PWA.
4. Re-add the projects from the v1 export, whose `base_branch` is v2's
   `integration_branch`:

   ```sh
   jq -c '.[] | {name, repo_dir, forge_repository,
     integration_branch: (if (.base_branch // "") == "" then null else .base_branch end)}' projects.json |
   while read -r project; do
     curl -fsS -H 'content-type: application/json' \
       ${OAKRIDGE_CONTROL_TOKEN:+-H "authorization: Bearer $OAKRIDGE_CONTROL_TOKEN"} \
       -d "$project" http://127.0.0.1:8790/api/projects
   done
   ```
5. Admit traffic after the new stack is healthy.

## Agent context

Per-package `CLAUDE.md` and `AGENTS.md` files are generated from `.catagents/`
sources. Rebuild them with `catagents` when that tool is available.
