# oakridge-core

A generic workflow-orchestration **substrate**. It models a workflow as a directed
graph of typed stages connected by artifact-passing edges, runs instances of those
graphs to completion, persists everything to SQLite, and streams progress over SSE.

The substrate is deliberately domain-agnostic: aside from the bundled `delegated_session`
stage type, it ships **zero** built-in stage or artifact types. A consumer binary supplies
additional behavior by registering its own `StageType` and `ArtifactType` implementations
at boot.

The bundled `delegated_session` stage type is what makes the substrate useful out of the
box. Rather than running an agent in-process, it **delegates** execution to an external
session service — kbbl — over HTTP, and reconciles the result through callbacks. That
oakridge-core ⇄ kbbl split is the "v2" execution model; see
[Delegated session execution (v2)](#delegated-session-execution-v2) for the run model and
how to stand up both halves.

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
| `OAKRIDGE_PROMPTS_DIR` | `./prompts` | Directory of prompt templates referenced by `delegated_session` stages' `prompt_template_path`. |

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

### Running the full v2 system (oakridge-core + kbbl)

`cargo run` alone only starts the orchestrator. A `delegated_session` stage needs kbbl
running to execute the agent. The two are co-located services (loopback, or one tailnet
host) that talk only over HTTP:

1. **Start kbbl** (the session service): `./kbbl/scripts/kbbl-start` → `127.0.0.1:8788`.
   See `kbbl/README.md`.
2. **Start oakridge-core**: `cargo run` → `127.0.0.1:8790`.
3. **Register a workflow** whose `delegated_session` stage config points
   `execution_service_url` at kbbl (`http://127.0.0.1:8788`) and `callback_base_url` back
   at oakridge-core (`http://127.0.0.1:8790`), then `POST /workflow_runs` to start it.

oakridge-core drives the graph and state; kbbl spawns and supervises the agent and reports
back. Both default to loopback, and the callback endpoints are unauthenticated — keep them
on a trusted network (same host or Tailscale). See
[Delegated session execution (v2)](#delegated-session-execution-v2).

## Delegated session execution (v2)

The bundled `delegated_session` stage type runs an agent **out of process**. Instead of
driving a CLI agent itself, the substrate POSTs a session request to kbbl and lets kbbl
spawn and supervise the agent; kbbl reports back over HTTP callbacks. oakridge-core owns
the workflow graph and durable state; kbbl owns the live agent session.

**Flow**

1. A `delegated_session` stage activates and POSTs `{execution_service_url}/sessions` with
   the rendered prompt, workdir, model, `pre_authorized_tools`, declared `output_slots`,
   and a `callback` block (`base_url`, `stage_instance_id`, `emit_path`, `status_path`).
2. kbbl spawns the agent and returns `201 {"sid": "<session id>"}`. The stage records the
   sid in `external_ref` and streams while the agent runs.
3. kbbl calls back into oakridge-core:
   - `POST {base_url}{emit_path}` (`/stage_instances/:id/artifacts`) — agent emitted an artifact.
   - `POST {base_url}/stages/:id/approvals` — a tool hit the approval gate; the stage parks
     and surfaces in `GET /parked` with the `request_id` in `parked_meta`.
   - `POST {base_url}{status_path}` (`/stage_instances/:id/status`) — terminal `done`/`failed`.
4. An operator resolves a parked approval via `POST /stage_instances/:id/resume`;
   oakridge-core forwards the decision to kbbl, which unblocks the agent.

**Stage config** — the workflow graph node's `config` for a `delegated_session` stage
(`DelegatedSessionDefConfig`):

| Field | Purpose |
| --- | --- |
| `backend` | Agent backend forwarded verbatim to kbbl (`"claude-code"`, `"codex"`). |
| `prompt_template_path` | Template under `OAKRIDGE_PROMPTS_DIR`, rendered with the slot bindings. |
| `slot_bindings` | Map of template variable → input-slot binding. |
| `workdir` | Slot binding resolving to the agent's working directory. |
| `model` | Optional model override. |
| `pre_authorized_tools` | Tools kbbl allowlists before the first turn. |
| `yolo` | Auto-approve every tool (no operator gate). |
| `execution_service_url` | kbbl base URL, e.g. `http://127.0.0.1:8788`. |
| `callback_base_url` | This oakridge-core's own base URL — the callback origin kbbl uses. |

The kbbl URL and callback origin are **per-stage config in the workflow definition**, not
environment variables, so one oakridge-core can fan stages out to different kbbl instances.
The `delegated_session` stage type is registered unconditionally by `boot()`; it does not
depend on the consumer's `register_fn`.

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
| `POST /stage_instances/:id/artifacts` | `200` | **kbbl callback** — emit an artifact from a delegated session. Body `{output_name, body}`. |
| `POST /stage_instances/:id/status` | `200` | **kbbl callback** — terminal `done`/`failed` for a delegated session. |
| `POST /stages/:id/approvals` | `200` | **kbbl callback** — park the stage pending operator approval; `request_id` lands in `parked_meta`. |

The three `kbbl callback` rows are machine-to-machine, called by kbbl while a
`delegated_session` stage runs (see below). They are **unauthenticated** and identified
only by stage-instance id — safe only because they're loopback-/tailnet-bound in the
co-located deployment.

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

`boot` also runs migrations and crash recovery, and **always registers the bundled
`delegated_session` stage type** independently of `register_fn`. The bundled binary passes
a no-op `register_types` as its `register_fn`; that hook exists for a consumer to inject
*additional* stage/artifact types at boot (see
[Delegated session execution (v2)](#delegated-session-execution-v2)).

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
