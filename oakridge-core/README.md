# oakridge-core

A generic workflow-orchestration **substrate**. It models a workflow as a directed
graph of typed stages connected by artifact-passing edges, runs instances of those
graphs to completion, persists everything to SQLite, and streams progress over SSE.

The substrate is deliberately domain-agnostic: aside from the bundled `delegated_session`
stage type, it ships **zero** built-in stage or artifact types. A consumer binary supplies
additional behavior by registering its own `StageType` and `ArtifactType` implementations
at boot.

## Domain model

| Type | What it is |
| --- | --- |
| `Project` | Optional owner of runs; carries a `repo_dir` and metadata merged into a run's context. |
| `WorkflowDef` | A named, versioned graph: a map of `StageKey → StageNodeDef` plus `Edge`s wiring one stage's output slot to another's input slot. |
| `WorkflowRun` | A live execution of a `WorkflowDef`. Status: `pending → running → done`/`failed`. |
| `StageInstance` | A single stage's execution within a run. Status: `pending → running → parked → done`/`failed`. |
| `Artifact` | Typed JSON output emitted by a stage; revisable via `parent_artifact_id` + `version`. |
| `GateDecision` | A human/automated verdict (`pass` / `fail` / `rerun`) delivered to a parked stage. |

A run terminates by **quiescence**: when no stage instance is left `pending`,
`running`, or `parked`, the run task marks the run terminal and self-reaps.

## Architecture

- **`scheduler`** — `Coordinator` owns a map of active runs. Each run gets a `RunTask`
  (a `tokio` select loop over executor events + control messages) that activates
  stages as their inputs resolve, parks stages awaiting decisions, and drives the run
  to a terminal state. Supports crash recovery on boot.
- **`executor`** — `StageContext` / `StageHandle` surface stages use to emit artifacts,
  set status, and receive resume payloads.
- **`registry`** — `StageTypeRegistry` and `ArtifactTypeRegistry`; the extension point.
- **`events`** — in-memory `EventBus` with a per-scope ring buffer (1024 events) backing
  SSE backfill.
- **`db`** — `sqlx` (SQLite, WAL) with compile-time-checked queries and committed
  offline metadata (`.sqlx/`).
- **`http`** — `axum` router exposing the REST + SSE API and serving a static PWA.

## Build & run

```sh
cargo build
cargo test          # runs the unit + integration suite
cargo run           # starts the HTTP server
```

Configuration is read from the environment (`Config::from_env`):

| Var | Default | Purpose |
| --- | --- | --- |
| `OAKRIDGE_CORE_PORT` | `8790` | Listen port. |
| `OAKRIDGE_CORE_BIND` | `127.0.0.1` | Bind address for the HTTP listener. |
| `OAKRIDGE_CORE_DB` | `sqlite://oakridge-core.db` | SQLite URL (bare paths are prefixed with `sqlite://`). |
| `OAKRIDGE_CORE_PWA_DIR` | `./pwa` | Directory served as the static fallback. |
| `OAKRIDGE_CORE_CORS_ORIGINS` | unset | Comma-separated list of allowed browser origins. Empty or unset means same-origin only. |

The binary binds `127.0.0.1:<port>` by default and does not add a CORS layer unless
`OAKRIDGE_CORE_CORS_ORIGINS` is set. That keeps local development local-first while
still allowing explicit tailnet or homelab exposure when you opt in.

Local development:

```sh
cargo run
```

To run delegated workflow stages locally, start kbbl first, then oakridge-core:

```sh
# Terminal 1, from the repo root
./kbbl/scripts/kbbl-start /path/to/workdir

# Terminal 2, from oakridge-core/
KBBL_API_BASE_URL=http://127.0.0.1:8788 \
cargo run
```

kbbl listens on `127.0.0.1:8788` by default. oakridge-core listens on
`127.0.0.1:8790` by default. Direct kbbl sessions launched from the kbbl PWA or
`POST /sessions` continue to work; delegated workflow sessions are an additional path
where oakridge-core creates and tags a kbbl session for a workflow stage.

The runtime split is documented in [docs/runtime_delegation.md](docs/runtime_delegation.md).

Tailnet or homelab exposure:

```sh
OAKRIDGE_CORE_BIND=0.0.0.0 \
OAKRIDGE_CORE_CORS_ORIGINS=https://oakridge.tailnet.example \
cargo run
```

## HTTP API

### REST

| Method & path | Success | Notes |
| --- | --- | --- |
| `POST /projects` | `201` | Body `{name, repo_dir}`. |
| `GET /projects` · `GET /projects/:id` | `200` | `404` when missing. |
| `POST /workflow_defs` | `201` | Body `{name, version, graph}`. |
| `GET /workflow_defs` · `GET /workflow_defs/:id` | `200` | `404` when missing. |
| `POST /workflow_runs` | `201` | Body `{workflow_def_id, project_id?, context?}`; **creates and starts** the run. |
| `GET /workflow_runs` | `200` | Filters: `?status=&def_id=&project_id=`. |
| `GET /workflow_runs/:id` | `200` | Run fields flattened with inline `stage_instances`. |
| `GET /workflow_runs/:id/artifacts` | `200` | Filter: `?artifact_type=`. |
| `GET /stage_instances/:id` | `200` | `404` when missing. |
| `POST /stage_instances/:id/resume` | `202` | Body tagged `ResumePayload` (`{"kind":"gate_decision",...}`, `{"kind":"feedback_artifact",...}`, or `{"kind":"executor","payload":...}`); resumes a parked stage. **Expose only on a trusted network or behind an auth gateway — the server has no built-in authentication.** |
| `POST /executors/delegated_session/:stage_instance_id/emit/:output_name` | `200` | Delegated agents emit declared output artifacts directly to oakridge-core. Returns `{ "artifact_id": "..." }`. |
| `GET /artifacts/:id` | `200` | Returns the revision chain, root-first. |
| `GET /parked` | `200` | All currently parked stage instances. |

**Status-code conventions**

- `400` — validation failure (e.g. a non-object `context` supplied with a `project_id`).
- `404` — entity not found / unknown registry id.
- `409` — conflict: the target stage is not `parked`, a unique constraint is violated,
  or a gate decision races a run that has already gone inactive.
- `500` — unexpected server error. The detail is logged server-side; the response body
  is a fixed `{"error":"internal server error"}` and never leaks internals.

### SSE

| Path | Scope |
| --- | --- |
| `GET /events` | All runs (global stream). |
| `GET /workflow_runs/:id/events` | A single run. |

Data events are unnamed SSE messages whose JSON payload carries a `kind` field; the SSE
`id` is a monotonic `seq`. Reconnect with `?since=<seq>` or the `Last-Event-ID` header
(`?since` wins). If the requested `since` predates the retained buffer, the stream first
emits a named `gap` event (`{"oldest_seq": N}`) — clients should reload state via REST
and resubscribe from `oldest_seq`.

## Delegated sessions

See [docs/runtime_delegation.md](docs/runtime_delegation.md) for the full split between
`delegated_session` and `delegated_lbc_run`, the workflow JSON examples, output
directory semantics, terminal metadata, and the opt-in real CLI smoke test.

## Extending the substrate

A consumer binary registers its types and boots the substrate:

```rust
use oakridge_core::{boot, Config};
use oakridge_core::registry::{StageTypeRegistry, ArtifactTypeRegistry};

let (app, coordinator) = boot(Config::from_env()?, |stages: &mut StageTypeRegistry,
                                                    artifacts: &mut ArtifactTypeRegistry| {
    stages.register(/* Arc<dyn StageType> */);
    artifacts.register(/* ArtifactTypeDef */);
}).await?;
```

- Implement `StageType` (`id`, `build_config`, `execute`) for each kind of work; `execute`
  returns a `StageHandle` the scheduler uses to resume or cancel the stage.
- Register an `ArtifactTypeDef` (`id`, `validate`, `component_id`) for each artifact shape.
- A graph node's `stage_type` / artifact `artifact_type` strings must match registered ids;
  an unknown id fails that stage (and terminates the run) rather than hanging it.

`boot` also runs migrations and crash recovery. The bundled binary passes
`register_types` as its `register_fn`, which registers the built-in
`delegated_session` stage type. `delegated_session` keeps artifact approval and
merge confirmation as distinct gate steps, so a kbbl session ending is not
itself treated as stage completion.

Delegated agents receive their runtime MCP server configuration from kbbl or a
workdir-local `.mcp.json`, not from oakridge-core generating per-instance Claude
config.

## Dev-flow package

`oakridge-core` ships a ready-to-use dev-flow workflow under `examples/dev_flow.json`
and `prompts/dev-flow/`. The workflow runs four sequential stages, each a
`delegated_session`:

| Stage | Output artifact | Description |
| --- | --- | --- |
| `spec_analyzer` | `dev.spec_analysis` | Reads the codebase and the brief; catalogs requirements, findings, and risks. |
| `plan_writer` | `dev.plan` | Converts the spec analysis into an ordered, cohort-based implementation plan. |
| `build` | `dev.build_result` | Implements the plan commit-by-commit and emits a build result. |
| `assessor` | `dev.assessment` | Evaluates the build result against the plan's acceptance criteria. |

The workflow also registers `dev.pr_summary` as a known artifact type for future
PR-ownership wiring, but it is not connected to any stage in the first graph.

### Required run context

| Key | Type | Purpose |
| --- | --- | --- |
| `brief_notes` | string | The brief or spec content forwarded to `spec_analyzer`. |
| `worktree_path` | string | Absolute path to the git worktree the agent operates in. |
| `oakridge_url` | string | `http://host:port/` of the running oakridge-core process; agents POST artifacts here. |

### Load the workflow

```bash
CORE=http://127.0.0.1:8790

curl -sX POST "$CORE/workflow_defs" \
  -H 'content-type: application/json' \
  -d "$(jq '{name,version,graph}' oakridge-core/examples/dev_flow.json)"
```

See `docs/oakridge-v2-runbook.md` for a full walkthrough.

### Tool approval policy

`pre_authorized_tools` is kept on the config struct for contract stability, but
any non-empty value is rejected at `build_config` time with an "unsupported"
error. Per-tool approval is the kbbl PWA's responsibility (Phase 2). All
dev-flow stages keep `yolo: false` so tool approvals remain visible in the kbbl
PWA while oakridge-core owns only workflow gates.

## Persistence & migrations

Schema lives in `src/db/migrations/` (a single consolidated `0001_initial`) and is
applied automatically on boot. Add schema changes as new additive migrations — never
edit shipped ones.

Run-owned rows cascade when a `workflow_run` is deleted. Artifact revision trees are
also cascade-owned: deleting a parent artifact deletes its descendant revisions. If a
future product requirement needs artifact audit retention independent of a run, change
that lifecycle first and add a migration rather than relying on detached revisions.

Compile-time-checked queries (`query!` / `query_as!`) rely on committed offline metadata
in `.sqlx/`. After changing such a query's SQL, regenerate it against a migrated database:

```sh
SQLX_OFFLINE=false cargo sqlx prepare
```

Runtime `QueryBuilder` queries do not require regeneration.
