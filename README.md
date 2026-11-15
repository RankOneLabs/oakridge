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

## Install and start

Linux is supported. Install Bash 4.3+, Bun, Git, openssl, the Rust toolchain
pinned in `workflow-core/rust-toolchain.toml` and its `wasm32-unknown-unknown`
target. Install Docker, or provide an external PostgreSQL database through
`DBOS_SYSTEM_DATABASE_URL`. Install the Claude Code (`claude`) or Codex
(`codex`) CLI for the ACP agent profiles you want to operate; `bun install`
installs their ACP adapters.

```bash
git clone https://github.com/RankOneLabs/oakridge.git
cd oakridge
bun install --frozen-lockfile
./scripts/oakridge-start
```

No gated-review configuration is needed for this path. The launcher initializes
database state, builds the evaluator and PWA, starts DBOS and kbbl, and prints
the local PWA URL. In another terminal, run:

```bash
bun run doctor
```

Doctor always runs the launcher's shared static checks, even with the stack
stopped. It then renders DBOS's `/api/install-status` model, also available in
the PWA's **Status** view: access mode, required stack checks, all ACP agent
profiles and their authentication/skill readiness, selected PR integration,
observation/grading availability, and per-definition launch blocks. A stopped
stack is reported with its URL and startup command. Only required check
failures cause an installation failure or a nonzero doctor exit. Missing or
broken optional integrations and unauthenticated agents carry details and fixes
without failing the installation. The launch form disables definitions listed
in the same model's launch blocks and shows the preflight reason and remedy.

Starting Oakridge needs no agent or GitHub credentials. Operating an ACP agent
needs an authenticated Claude Code or Codex CLI. Each CLI manages its own model
credentials: use `claude auth login` or `codex login`. Missing credentials surface
as an agent-auth error while the core stays running; doctor and Status report
per-profile readiness. Disabled profiles remain visible. Custom profiles without
a supported authentication probe report that introspection is unavailable.

The full GitHub development workflow needs a GitHub remote, a PR integration,
and the PR lifecycle; offline development is not supported in this release.
Choose `OAKRIDGE_PR_INTEGRATION=gated-review`, `github-cli`, or `none` before
starting. Without an explicit choice, the launcher selects gated-review when
configured, otherwise none. Each run keeps its recorded integration on resume
and retry. With github-cli, the operator's own git/gh authentication is used
(`gh auth login`); automatic merge observation is off, and merges complete
through the manual **Confirm merged** action. The run page persistently states
this on every merge-stage unit. With gated-review, GitHub App credentials stay
in the gateway. With none, no GitHub credentials are needed; PR-dependent
workflows are blocked before launch, while other definitions can launch.
Gating is instruction-level: Oakridge does not enforce git/gh use at runtime.
A target repository's agent permissions must allow the commands used by the
selected integration skill.

To enable gated-review, copy `.mcp.example.json` to the gitignored `.mcp.json`
and set the `gated-review` HTTP server's nonempty URL. Its absence is harmless.
Tailscale and remote services are optional. Observation/grading is optional:
start with `./scripts/oakridge-start --observation` to enable it; see
[observation operations](docs/observation-operations.md).

Loopback binds need no control token. A non-loopback bind requires
`OAKRIDGE_CONTROL_TOKEN` (any nonempty value), or the explicit override
`ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1`. Status labels these modes **Local**,
**Authenticated network**, and **Insecure network**, and shows the bind host.
`0.0.0.0` exposes every network interface, not only Tailscale. The status model
never includes the token value.

`./scripts/oakridge-lan` binds to `0.0.0.0` and no longer unsets the token.
Set `OAKRIDGE_CONTROL_TOKEN` (or `ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1`) in the
shell or in the checkout's root `.env` before the next oakridge-lan restart; a
shell value wins over `.env`. Neither is read from the state directory. The
wrapper preserves authenticated access, uses a loopback-only Bun inspector,
and appends output to `~/.local/state/oakridge/run-<date>.log`.
Other arguments, including `--observation`, pass through. Unless
`OAKRIDGE_ALLOWED_ORIGINS` is set, the launcher allows browser writes from
loopback and the addresses selected for the bind, and prints the list.
The backend publication key is separate: it is generated on first start at
`~/.local/state/oakridge/publication.key`, beside the agent workdir.

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

The DBOS application version defaults to a 16-character SHA-256
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
`OAKRIDGE_SHADOW_STATE_DIR` run further instances; gated-review comes from the checkout's local `.mcp.json`, if present.
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
