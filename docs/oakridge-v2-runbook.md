# Oakridge v2 Readiness Runbook

This is the canonical Phase 2 operator runbook for Oakridge v2. It covers how to
run the first real dev-flow workflow, what the worktree and effort contracts look
like, where tool approvals live, and what v1 behavior is not yet covered.

Oakridge v2 uses `oakridge-core` as the workflow orchestrator and delegates
runtime execution to the subsystem that owns that runtime:

- `delegated_session` delegates interactive work to kbbl sessions.
- `delegated_lbc_run` delegates headless autonomous work to the legit-biz-club
  CLI bridge.

Use this guide when you want oakridge-core to create and run workflow stages. For
direct operator-created kbbl sessions, see `kbbl/README.md`. For the v1
kbbl-owned dev-flow (Epic → Spec → Plan → Build → Assess), see
`docs/agent-dev-flow.md`.

## v1-to-v2 Migration Map

> **Maintenance note**: update this table in the same PR whenever v2 parity
> changes. A stale map is worse than no map.

| v1 Concept | v2 Mapping | Phase 2 Status |
| --- | --- | --- |
| **Epic** | project + workflow context (run carries repo and task metadata) | partial — v2 has no named Epic entity; project ties a repo to runs |
| **Spec** | input artifact (brief notes in run context) + `dev.spec_analysis` stage output | partial — spec analysis runs; no persistent Spec record or discrepancy workflow |
| **Plan** | `dev.plan` artifact emitted by `plan_writer` stage + artifact-approval gate | partial — plan cohorts and their dependencies drive the build fan-out DAG; there is no DAG editor |
| **Cohort** | a fanned `stage_session_units` row keyed by the plan cohort id, with its own session and worktree | partial — cohort execution is durable and independently gated, but there is no standalone Cohort entity |
| **Brief** | prompt templates (`oakridge-core/prompts/dev-flow/`) + scoped stage inputs bound at run time | partial — templates drive each stage; no standalone Brief artifact or review surface |
| **Assessment** | `dev.assessment` artifact emitted by `assessor` stage | partial — assessor runs and emits; no Assessment inbox or accept/reject lifecycle |
| **PR merge** | per-cohort PR opened by the seeded build agent + merge-confirmation gate | partial — the agent emits `dev.pr_summary` and v2 shows its PR URL, branch, and path; v2 does not merge the PR |

## What You Will Run

This runbook starts two local services:

| Service | Default URL | Role |
| --- | --- | --- |
| kbbl | `http://127.0.0.1:8788` | Runs visible interactive agent sessions for `delegated_session`. |
| oakridge-core | `http://127.0.0.1:8790` | Owns workflow definitions, runs, stages, artifacts, gates, and event streams. |

This runbook includes two workflow examples:

- An interactive `delegated_session` workflow, where oakridge-core creates a
  visible kbbl session and parks for operator approval.
- A headless `delegated_lbc_run` workflow, where oakridge-core writes a
  `run-spec.json`, invokes legit-biz-club, parses the `RESULT` line, and emits a
  metadata artifact.

## Prerequisites

- Bun installed for the kbbl package.
- Rust and Cargo installed for oakridge-core.
- A local Git checkout for the target workdir the agent will operate in.
- Runtime credentials available to the kbbl process. For the default Claude
  Code runtime, **do not export `ANTHROPIC_API_KEY`** — the Claude Code adapter
  requires subscription OAuth and hard-rejects any API key. Ensure the variable
  is absent from your shell before starting kbbl:

  ```bash
  unset ANTHROPIC_API_KEY
  ```

  Log in once with `claude` (the Claude Code CLI) so the subscription OAuth
  token is cached, then start kbbl normally. You can verify the setup is correct
  by spawning a Claude Code session through the kbbl operator path and confirming
  it reaches `live` without an `A.1` billing-guard error.
- For `delegated_lbc_run`, `uv` and legit-biz-club dependencies available in
  the environment where oakridge-core runs.
- Trusted local network access only. These development servers do not provide a
  production authentication boundary.

Install repo dependencies once:

```bash
bun install
```

## Start kbbl For Interactive Stages

From the repository root:

```bash
./kbbl/scripts/kbbl-start /abs/path/to/target/repo --host=127.0.0.1
```

Verify kbbl:

```bash
curl -sI http://127.0.0.1:8788/ | head -1
```

Open `http://127.0.0.1:8788/` in a browser. Delegated sessions created by
oakridge-core will appear in this kbbl UI.

You can skip kbbl only when running workflows that exclusively use
`delegated_lbc_run`.

## Start oakridge-core

In a second terminal:

```bash
cd oakridge-core
OAKRIDGE_CORE_DB=sqlite://oakridge-core.db \
KBBL_API_BASE_URL=http://127.0.0.1:8788 \
cargo run
```

Verify oakridge-core:

```bash
curl -s http://127.0.0.1:8790/workflow_defs
```

`KBBL_API_BASE_URL` tells oakridge-core where to create delegated kbbl sessions.
It is service configuration, not workflow JSON.

## Packaged Prompt Templates

`delegated_session` reads prompt templates from a prompts directory. The bundled
dev-flow workflow ships its templates at `oakridge-core/prompts/dev-flow/`.

### Prompt root configuration

oakridge-core resolves `prompt_template_path` relative to `OAKRIDGE_PROMPTS_DIR`.
The default is `./prompts` relative to the directory where `cargo run` is invoked
(i.e., `oakridge-core/prompts` when started from `oakridge-core/`).

To use a different root:

```bash
OAKRIDGE_PROMPTS_DIR=/abs/path/to/my/prompts cargo run
```

**Important**: every `prompt_template_path` in a workflow definition must resolve
to a path **inside** `OAKRIDGE_PROMPTS_DIR`. Paths that escape the prompt root
are rejected at config-build time.

### Required templates for the dev-flow package

The bundled `oakridge-core/examples/dev_flow.json` references these template IDs
under `prompts/dev-flow/`:

| Template file | Stage |
| --- | --- |
| `dev-flow/spec_analyzer.md` | `spec_analyzer` |
| `dev-flow/plan_writer.md` | `plan_writer` |
| `dev-flow/build.md` | `build` |
| `dev-flow/assessor.md` | `assessor` |

All four must be present before the workflow starts. A missing template fails
during workflow config validation/build before a kbbl session is created.

### Custom prompt templates

Example template `stage.md` (placed under `OAKRIDGE_PROMPTS_DIR/`):

```markdown
Implement this task:

{{TASK}}

Emit the result artifact to oakridge-core when complete.
```

The delegated agent must eventually POST an artifact to:

```http
POST /executors/delegated_session/:stage_instance_id/units/:unit_id/emit/:output_name
```

For the current single-session case (no `fan_out` config), `unit_id` is always `0`:

```http
POST /executors/delegated_session/<stage_instance_id>/units/0/emit/<output_name>
```

The `/units/:unit_id/` segment is required in all cases. The implicit-unit constant `"0"` is
part of the route contract for N=1 stages; it will match the `unit_id` in the stage's
`stage_session_units` row and in the gate id returned by `GET /parked` and `GET /runs/:id/gates`.

## Create A Project In oakridge-core

Projects are optional, but using one injects the target repo path into the run
context.

```bash
CORE=http://127.0.0.1:8790

curl -sX POST "$CORE/projects" \
  -H 'content-type: application/json' \
  -d '{"name":"target","repo_dir":"/abs/path/to/target/repo"}'
```

Save the returned `id` as `PROJECT_ID`.

## Worktree Contract

When kbbl creates a managed worktree for a session, it takes a `worktree` object
in the `POST /sessions` body:

```json
{
  "workdir": "/abs/path/to/target/repo",
  "worktree": {
    "branchName": "cohort/myepic/1-myslug",
    "worktreeSubdir": "myepic/1-myslug",
    "baseRef": "main"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `branchName` | yes | New branch created for the worktree. Must be a valid git ref name. |
| `worktreeSubdir` | yes | Relative subdirectory under kbbl's worktree root where the tree is checked out. Must be non-empty, non-absolute (no leading `/`), must not start with `~`, must not contain traversal segments (`..`), must not contain empty or `.` path segments, and must not contain shell-significant characters. |
| `baseRef` | no | Ref to use as the worktree base. When provided, must resolve in the target repository — `git worktree add` fails if the ref does not exist yet. When absent, kbbl uses the repository's current `HEAD`. |

**Failure mode**: if `baseRef` is supplied and does not resolve, the session
creation fails with a worktree setup error before any agent subprocess is spawned.
Verify the ref exists in the local clone before submitting.

The worktree identity is the primary v1/v2 topology gap. v1 kbbl cohorts carry
a named cohort identity; v2 stages use generic branch + path metadata from the
session instead.

## Session Metadata

Two shapes expose worktree metadata — the kbbl session snapshot and the oakridge
stage detail:

**kbbl session snapshot** (returned by `POST /sessions`, `GET /sessions`, and
inbox events):

| Field | Type | Meaning |
| --- | --- | --- |
| `sid` | string | kbbl session identifier |
| `worktreePath` | string \| null | Absolute path to the checked-out worktree |
| `worktreeBranch` | string \| null | Branch name the worktree is on |
| `worktreeBaseRef` | string \| null | Base ref that was used when the worktree was created |

**Oakridge stage detail** (returned by `GET /workflow_runs/:id` in the
`stage_instances` array and surfaced in the kbbl PWA oakridge run detail):

| Field | Type | Meaning |
| --- | --- | --- |
| `worktree` | object \| null | Present when the delegated session has worktree metadata |
| `worktree.branch` | string | Branch name |
| `worktree.path` | string | Absolute path to the worktree |
| `worktree.base_ref` | string | Base ref used at creation |

In the kbbl PWA oakridge surface, each stage row shows `worktree.branch` and
`worktree.path` when available. The parked gate panel also surfaces these fields
so the operator can confirm the correct branch and path before approving a
merge-confirmation gate.

**Blind merge confirmation is explicitly out of bounds.** When a stage reaches
the merge-confirmation gate, the branch and path must be visible before the
operator clicks pass. If the operator cannot see the branch and path, do not
approve the gate.

## Effort Setting

Each delegated session can optionally carry a reasoning-effort level:

| Value | Notes |
| --- | --- |
| `minimal` | Lowest effort; fastest and cheapest. |
| `low` | Light reasoning pass. |
| `medium` | Balanced default for most tasks. |
| `high` | Deep reasoning; more thorough but slower. |
| `xhigh` | Extra-high reasoning for difficult tasks. |
| `max` | Maximum reasoning for the hardest quality-first tasks. |

Omitting `effort` (or setting it to `null`) uses the runtime's default effort
for that model tier. The `effort` field is forwarded to the kbbl session and
passed to the agent subprocess at spawn time.

In a workflow definition, `effort` is an optional field on the `delegated_session`
config alongside `model` and `yolo`:

```json
{
  "stage_type": "delegated_session",
  "config": {
    "runtime": "claude-code",
    "prompt_template_path": "dev-flow/build.md",
    "effort": "medium",
    "yolo": false,
    "pre_authorized_tools": []
  }
}
```

## Run An Interactive delegated_session Workflow

This single-stage workflow starts a kbbl session, sends the rendered prompt, and
waits for the delegated agent to emit an artifact named `out`.

```bash
curl -sX POST "$CORE/workflow_defs" \
  -H 'content-type: application/json' \
  -d '{
    "name": "interactive-build",
    "version": 1,
    "graph": {
      "stages": {
        "build": {
          "stage_type": "delegated_session",
          "config": {
            "runtime": "claude-code",
            "prompt_template_path": "stage.md",
            "slot_bindings": {
              "TASK": { "from": "context", "path": "/task" }
            },
            "workdir": { "from": "context", "path": "/workdir" },
            "session_name": "oakridge-build-{{STAGE_INSTANCE_ID}}",
            "model": null,
            "pre_authorized_tools": [],
            "yolo": false
          },
          "inputs": [],
          "outputs": [
            { "name": "out", "artifact_type": "text" }
          ]
        }
      },
      "edges": []
    }
  }'
```

Save the returned `id` as `WORKFLOW_DEF_ID`.

Important details:

- `runtime` is forwarded to kbbl. Use `"claude-code"` or `"codex"`.
- For Codex-backed sessions, enable Codex in `kbbl/config.json` before using
  `"runtime": "codex"`.
- `pre_authorized_tools` is reserved for future create-time allowlist support.
  Use kbbl approvals or `yolo` for the current delegated flow.

## Start A Workflow Run

```bash
curl -sX POST "$CORE/workflow_runs" \
  -H 'content-type: application/json' \
  -d '{
    "workflow_def_id": "<WORKFLOW_DEF_ID>",
    "project_id": "<PROJECT_ID>",
    "context": {
      "task": "Make the requested change, then emit a concise result artifact.",
      "workdir": "/abs/path/to/target/repo"
    }
  }'
```

Save the returned `id` as `RUN_ID`.

oakridge-core creates a stage instance, starts a kbbl session, stores the kbbl
session id in `stage_instance.external_ref`, sends the prompt through kbbl, and
polls kbbl events. The session is visible in the kbbl PWA and in the oakridge
surface at `#oakridge`.

## Observe The Run

Fetch run state:

```bash
curl -s "$CORE/workflow_runs/$RUN_ID"
```

Fetch global or run-scoped SSE:

```bash
curl -N "$CORE/events"
curl -N "$CORE/workflow_runs/$RUN_ID/events"
```

Find parked stages:

```bash
curl -s "$CORE/parked"
```

Find the kbbl session for a stage:

```bash
curl -s "$CORE/workflow_runs/$RUN_ID"
curl -s "http://127.0.0.1:8788/artifacts/<stage_instance_id>/sessions"
```

## Artifact Emit And Gates

The delegated agent emits the declared output artifact. For the N=1 implicit-unit
case (no `fan_out` config), the unit id is always `0`:

```bash
curl -sX POST "$CORE/executors/delegated_session/<stage_instance_id>/units/0/emit/out" \
  -H 'content-type: application/json' \
  -d '{"result":"done","notes":"artifact body is workflow-specific JSON"}'
```

After emit, oakridge-core parks the stage for artifact approval. Approve it:

```bash
curl -sX POST "$CORE/stage_instances/<stage_instance_id>/resume" \
  -H 'content-type: application/json' \
  -d '{
    "kind": "gate_decision",
    "decision": {
      "outcome": "pass",
      "comment": null,
      "feedback": null
    },
    "against_artifact_id": "<artifact_id>"
  }'
```

The first pass moves the stage to merge confirmation. At the merge-confirmation
gate, verify that the displayed branch and worktree path match what you expect
before approving. Approve after the operator confirms the change is merged or
otherwise accepted:

```bash
curl -sX POST "$CORE/stage_instances/<stage_instance_id>/resume" \
  -H 'content-type: application/json' \
  -d '{
    "kind": "gate_decision",
    "decision": {
      "outcome": "pass",
      "comment": null,
      "feedback": null
    },
    "against_artifact_id": "<artifact_id>"
  }'
```

The stage then reaches `done`, oakridge-core stops the kbbl session
best-effort, and the run completes by scheduler quiescence.

For changes-needed feedback, send a failing or rerun gate decision. The
delegated-session executor forwards the feedback into the same live kbbl
session as follow-up input.

## Run A Headless delegated_lbc_run Workflow

Use `delegated_lbc_run` for autonomous legit-biz-club work that should not
become a visible kbbl session. The stage creates an output directory if needed,
writes `run-spec.json`, invokes the bridge command, scans stdout for the final
valid `RESULT` line, and emits one result artifact containing paths and
metadata.

Create a workflow definition:

```bash
curl -sX POST "$CORE/workflow_defs" \
  -H 'content-type: application/json' \
  -d '{
    "name": "headless-lbc-run",
    "version": 1,
    "graph": {
      "stages": {
        "study": {
          "stage_type": "delegated_lbc_run",
          "config": {
            "task": { "from": "literal", "value": "code_leetcode_longest_substring" },
            "model_pool": { "from": "literal", "value": ["claude-sonnet-4-5"] },
            "condition": { "from": "literal", "value": { "kind": "single_agent", "n": 1 } },
            "grade": { "from": "literal", "value": false },
            "output_dir": { "from": "context", "path": "/lbc_output_dir" },
            "bridge_command": "uv",
            "bridge_args": ["run", "python", "-m", "legit_biz_club.run"],
            "result_output_slot": "result"
          },
          "inputs": [],
          "outputs": [
            { "name": "result", "artifact_type": "text" }
          ]
        }
      },
      "edges": []
    }
  }'
```

Save the returned `id` as `LBC_WORKFLOW_DEF_ID`, then start the run:

```bash
curl -sX POST "$CORE/workflow_runs" \
  -H 'content-type: application/json' \
  -d '{
    "workflow_def_id": "<LBC_WORKFLOW_DEF_ID>",
    "project_id": null,
    "context": {
      "lbc_output_dir": "/abs/path/to/lbc-output"
    }
  }'
```

On success, the emitted artifact body includes:

- `artifact_path`
- `output_dir`
- `run_spec_path`
- `run_spec`
- `eval_scores`
- `sidecars`

The core stores metadata and paths only. It does not copy the full
legit-biz-club output directory into oakridge-core storage.

If the bridge exits non-zero, omits `RESULT`, prints invalid `RESULT` JSON, or
returns an invalid payload, the stage fails and records structured
`terminal_meta` on the stage instance. Cancellation kills the bridge process
best-effort and is also recorded in `terminal_meta`.

## Run The Dev-Flow Workflow

The dev-flow workflow is a four-stage `delegated_session` pipeline with two
definitions:

- `oakridge-core/examples/dev_flow.json` (version 1) runs one session per stage.
- `oakridge-core/examples/dev_flow_v2.json` (version 2) fans build and assessment
  out over the cohorts produced by the plan.

### Workflow graph

```
spec_analyzer → plan_writer → build → assessor
```

| Stage | Output artifact | Description |
| --- | --- | --- |
| `spec_analyzer` | `dev.spec_analysis` | Reads the codebase and the brief; catalogs requirements, findings, and risks. |
| `plan_writer` | `dev.plan` | Converts the spec analysis into an ordered implementation plan. |
| `build` | `dev.pr_summary`, `dev.build_result` | Implements the plan in one independently gated unit per cohort. |
| `assessor` | `dev.assessment` | Evaluates each cohort's build result against the plan's acceptance criteria. |

Each stage is a `delegated_session` with typed artifacts and artifact-approval
and merge-confirmation gates. Version 1 retains the implicit unit id `"0"` and
single-session behavior.

In version 2, `plan_writer` emits a `cohorts` array and `build` materializes one
unit per cohort. Each build unit has its own kbbl session, branch, worktree,
artifacts, gates, and PR metadata. A cohort starts only after all ids in its
`depends_on` list are `done`; independent cohorts may run concurrently, up to
the stage's `fan_out.max_parallel` limit. Dependencies control execution order
only: every build worktree uses the configured run base rather than a preceding
cohort's branch.

The seeded `assessor` inherits the build fan-out by unit id. It starts after the
complete build stage is done and each assessor unit receives only the matching
cohort's `dev.build_result`. A custom aggregate consumer can instead declare
`collect: true` on an input slot; it receives a deterministic unit-id-ordered
array of `{ "unit_id": "...", "artifact": ... }` envelopes after the producer
stage is done.

### Prerequisites

- kbbl and oakridge-core running (see earlier sections).
- A git worktree already checked out where the agent should work.
- `OAKRIDGE_PROMPTS_DIR` pointed at `oakridge-core/prompts` (or started from the
  `oakridge-core/` directory where `./prompts` is the default).

### Create the workflow definition

```bash
CORE=http://127.0.0.1:8790

curl -sX POST "$CORE/workflow_defs" \
  -H 'content-type: application/json' \
  -d "$(jq '{name,version,graph}' oakridge-core/examples/dev_flow_v2.json)"
```

Save the returned `id` as `DEV_FLOW_DEF_ID`. Use `dev_flow.json` instead when
you specifically need the version 1 single-session workflow.

### Start a run

```bash
curl -sX POST "$CORE/workflow_runs" \
  -H 'content-type: application/json' \
  -d "{
    \"workflow_def_id\": \"$DEV_FLOW_DEF_ID\",
    \"context\": {
      \"brief_notes\": \"Implement the feature described in <brief here>.\",
      \"worktree_path\": \"/abs/path/to/worktree\",
      \"oakridge_url\": \"http://127.0.0.1:8790/\"
    }
  }"
```

`brief_notes` is passed verbatim into the `spec_analyzer` prompt.

### Gate decisions

Each stage or fan-out unit parks for artifact approval after emitting its gate
output. The gate cycle is the same as any other `delegated_session` stage:

1. `POST /stage_instances/<id>/resume` with `outcome: "pass"` after review.
2. A second pass moves from artifact approval to merge confirmation and then to
   `done`. At merge confirmation, the operator must verify the displayed PR URL,
   branch, and path when present before approving — blind approval is not
   acceptable. A dependent fan-out unit is not eligible until this pass marks
   every dependency `done`.
3. A `fail` or `rerun` decision sends feedback into the live kbbl session so the
   agent can revise its output.

## Tool Approval Policy

Tool approvals are the **kbbl PWA's responsibility** for Phase 2. oakridge-core
workflow gates are separate from per-tool approvals and operate at the artifact
level, not the tool-call level.

`pre_authorized_tools` is present in the `delegated_session` config struct for
contract stability, but any non-empty value is **rejected at `build_config` time**
with:

```
pre_authorized_tools is not supported: per-tool approval is managed by the kbbl PWA (Phase 2). Remove pre_authorized_tools from the workflow definition or set it to an empty array.
```

All first-party workflow definitions (including `examples/dev_flow.json`) use:

```json
"pre_authorized_tools": [],
"yolo": false
```

All dev-flow stages keep `yolo: false` so per-tool control stays in the kbbl
PWA. Use the kbbl PWA's per-session approval cards or the session-scoped
"Always {tool}" button when a delegated session parks on a tool request. A
standalone tool-approval surface in oakridge-core is out of scope for Phase 2.

## kbbl PWA Oakridge Entry Point

The kbbl PWA exposes a dedicated oakridge surface at:

```
http://127.0.0.1:8788/#oakridge
```

This surface requires `OAKRIDGE_CORE_BASE_URL` to be configured on the kbbl
server process. When unset, the shell displays an "oakridge-core not configured"
message in place of the run list.

### Run list (`#oakridge`)

Lists all workflow runs with status, current stage, parked count, and
last-updated time. Click any run to open the run detail view.

### Run detail (`#oakridge/run/<id>`)

Shows the stage timeline table with per-stage columns:
- **Stage** — stage key from the workflow definition
- **Type** — stage type (e.g., `delegated_session`)
- **Status** — current stage status with status chip
- **Artifacts** — clickable chips for each emitted artifact type
- **Session** — link to the delegated kbbl session when present (navigates to
  `#sid=<sid>` in the kbbl inbox)
- **Worktree** — branch name and path when the session has worktree metadata

Fanned stages expand into unit rows. Each unit row shows its own status,
session, worktree, and emitted artifacts; N>1 state is authoritative on these
unit rows rather than mirrored onto the parent stage row.

The run detail also shows a **Refresh** button and the parked gate panel (see
below).

### Parked gate panel

When any stage in the run is parked, the gate panel renders below the stage
table. Each parked gate shows:
- Gate type (artifact approval vs. merge confirmation)
- Stage name and artifact revision id
- Worktree branch and path (when present) — **read before approving a
  merge-confirmation gate**
- Pass / Fail / Rerun action buttons

The `id` field on each gate returned by `GET /parked` and `GET /runs/:id/gates` is a
**composite gate id** with the form `"{stage_instance_uuid}:{unit_id}"`. For a
single-unit (N=1) stage this is `"{uuid}:0"`; for a fanned stage the suffix is
the materialized unit id. Pass this composite id when calling
`POST /gates/:id/resume` directly via curl:

```bash
# composite_id is the "id" field from GET /parked (e.g. "abc...def:0")
curl -sX POST "$CORE/gates/<composite_id>/resume" \
  -H 'content-type: application/json' \
  -d '{
    "outcome": "pass",
    "comment": null,
    "feedback": null,
    "against_artifact_id": "<artifact_id>"
  }'
```

The `unit_id` suffix is `"0"` for every stage that does not have a `fan_out` config.

### Artifact inspection (`#oakridge/artifact/<id>`)

Shows the artifact revision chain with body, status, and created-at timestamp
for each revision. Navigate here from the artifact chips in the stage table.

### Delegated session links

Each single-session stage row, or unit row within a fanned stage, links to the
kbbl session that executed it. Clicking the link navigates to `#sid=<sid>`,
opening the full session transcript in the kbbl inbox. This is the primary path
for inspecting what the delegated agent did, reviewing its transcript, and
sending follow-up input after a gate rejection.

## Multi-session Fan-out

`delegated_session` supports durable N>1 fan-out while preserving the implicit
unit `"0"` path for definitions without `fan_out`.

### stage_session_units table

The `stage_session_units` table is keyed by `(stage_instance_id, unit_id)` and
stores per-unit parameters, dependencies, kbbl session id, worktree identity,
status, gate state, artifact id, and terminal metadata. For N=1 stages, a single
row with `unit_id = "0"` is written when the session starts. N>1 units are
materialized from the array selected by `fan_out.over` before any session is
admitted.

The fan-out definition selects each unit id and optional dependency list with
RFC 6901 pointers. Unit ids must be non-empty and unique; dependencies must
refer to known units and form an acyclic graph. An empty source array completes
the stage with zero units. Item bindings and the `{{UNIT_ID}}` and
`{{STAGE_INSTANCE_ID}}` placeholders are rendered separately for every unit.

Pending units are admitted when all dependencies are done, bounded by
`fan_out.max_parallel`. A stage is `done` only when every unit is done. If any
unit is parked or failed, the aggregate stage is parked while unaffected
siblings continue; otherwise it remains running.

### Per-unit emit route

The emit route now includes a `units/:unit_id` segment:

```http
POST /executors/delegated_session/:stage_instance_id/units/:unit_id/emit/:output_name
```

Artifacts emitted through this route are labeled with `unit_id`, which preserves
producer identity for gates, downstream inherited fan-out, collections, retry,
and recovery. For N=1, use `unit_id = "0"`. See the "Artifact Emit And Gates"
section for the curl form.

### Composite gate id

Gates returned by `GET /parked` and `GET /runs/:id/gates` now carry a composite `id` of the
form `"{stage_uuid}:{unit_id}"`. For N=1 this is `"{uuid}:0"`. The `POST /gates/:id/resume`
route parses this composite id to route the decision. See the "Parked gate panel" section.

### Targeted retry

For an N>1 stage, `POST /stage_instances/:id/retry_stuck` requires the unit to
retry:

```json
{ "unit_id": "cohort-a" }
```

The selected unit must be failed, including a unit whose session ended without
emitting. Retry clears only attempt-local state and re-admits that unit through
the same dependency and concurrency checks; sibling state and artifact history
are preserved. Omitting `unit_id` retains the existing N=1 `stuck_timeout`
whole-stage retry and is rejected for a fanned stage.

### Recovery

On coordinator recovery, N>1 stage state is rebuilt from all persisted unit
rows. Each running or parked unit is independently probed and reattached by its
kbbl session id. Done units remain done, pending units are admitted when their
dependencies allow it, and temporarily unreachable sessions retry attachment
without blocking healthy siblings. See `oakridge-core/docs/runtime_delegation.md`
for the detailed recovery states.

## Not Covered in Phase 2

The following v1 behaviors are explicitly outside the Phase 2 scope:

- **PR merge** — the seeded v2 build agent opens one PR per cohort and emits a
  `dev.pr_summary`; oakridge-core surfaces the matching PR URL and worktree at
  the unit's merge-confirmation gate. The operator completes the merge itself.
- **Review-thread workflows** — comment threads, ping-responder, and
  reviewer-facing review surfaces exist only in the v1 kbbl dev-flow. There is
  no equivalent in the v2 workflow surface.
- **Full epic lifecycle management** — v1 Epics carry archive, delete, and status
  transitions across Spec/Plan/Build/Assess. v2 has no named Epic entity; runs do
  not carry Epic-level status.
- **Automatic retry of failed work** — delegated sessions reattach after a
  coordinator restart, including independent fan-out units. A failed unit is
  not automatically rerun; the operator uses targeted `retry_stuck` or fails
  the stage explicitly.
- **Standalone v2 tool approval UI** — there is no tool-approval surface in
  oakridge-core or the oakridge kbbl shell for Phase 2. Use the kbbl session
  approval cards directly.

## Optional Real LBC Smoke Test

The real legit-biz-club bridge smoke test is ignored by default because it may
need local dependencies and provider credentials.

Run it explicitly from `oakridge-core`:

```bash
OAKRIDGE_RUN_REAL_LBC_SMOKE=1 \
cargo test --test delegated_lbc_run_smoke -- --ignored
```

Set `OAKRIDGE_LBC_SMOKE_MODEL` to override the default model used by the smoke
test.

## Current Limitations

- `delegated_session` still uses kbbl polling and the core-owned artifact emit
  route. Callback-based kbbl delegation is out of scope.
- The operator UI for headless LBC result metadata and eval scores is still a
  separate product surface. Use REST artifacts, stage detail, and SSE for now.
- `delegated_lbc_run` persists metadata and paths only; callers inspect the LBC
  output directory directly for full runtime logs and sidecars.

## Direct kbbl Sessions

Direct kbbl sessions are still supported and do not require oakridge-core. Use
direct sessions when you want to start and steer an agent manually from the kbbl
PWA. Use this Oakridge v2 flow when you want workflow definitions, workflow
runs, stage instances, artifacts, gates, and SSE managed by oakridge-core.
