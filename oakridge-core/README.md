# oakridge-core

A generic workflow-orchestration **substrate**. It models a workflow as a directed
graph of typed stages connected by artifact-passing edges, runs instances of those
graphs to completion, persists everything to SQLite, and streams progress over SSE.

The substrate is deliberately domain-agnostic: aside from the bundled `session_agent`
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
`register_types` as its `register_fn`, which registers the built-in `session_agent`
stage type.

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
