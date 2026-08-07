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
| **Spec** | input brief + `dev.spec_analysis` artifact | runnable — discrepancies and review items are handled on the configurable artifact review page before approval |
| **Plan** | `dev.plan` artifact + descriptor-driven plan viewer and approval gate | runnable — the plan viewer renders cohort dependency edges and the approved plan drives build fan-out |
| **Cohort** | a fanned `stage_session_units` row keyed by plan cohort id | runnable — each cohort has a brief, dependency-aware manual admission, session/worktree, lifecycle state, and independent gates |
| **Brief** | the scoped cohort fields in `dev.plan` and the build prompt bindings | runnable — title, repository, scope, description, decisions, and acceptance criteria are shown before admission and passed to the worker |
| **Assessment** | per-cohort `dev.assessment` artifact emitted by `assessor` | runnable — assessment progress and cohort completion appear in the lifecycle inbox |
| **PR merge** | per-cohort PR + explicit merge-confirmation gate | runnable operator handoff — v2 displays PR URL/branch/worktree and records `confirm_merged` or `closed_without_merge`; merging remains external |

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

### One-command local stack

For the normal local v2 test path, start both services from the repository
root:

```bash
bun run oakridge
```

Then open `http://127.0.0.1:8788/#oakridge`. The command configures the kbbl
proxy to oakridge-core, rebuilds the PWA, and stops both services together on
Ctrl-C. It also removes `ANTHROPIC_API_KEY` from the kbbl process environment as
required by the default Claude Code subscription runtime.

### LAN or tailnet access

The browser only needs access to kbbl on port 8788. Keep oakridge-core on its
default loopback bind; kbbl forwards `/oakridge/api/*` to it server-side.
Prefer an authenticated bind:

```bash
export OAKRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
./scripts/oakridge-start --host=0.0.0.0
```

Open `http://<machine-ip-or-tailnet-name>:8788/#oakridge`. The browser prompts
for the token on first use. If the two services intentionally use different
tokens, set `OAKRIDGE_CORE_CONTROL_TOKEN` to the core token before starting.

For a short-lived development session on a trusted network only:

```bash
ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 \
  ./scripts/oakridge-start --host=0.0.0.0
```

This escape hatch disables authentication for reachable control routes and
prints a warning. It is not suitable for a public interface or untrusted LAN.
Do not set `OAKRIDGE_CORE_BIND=0.0.0.0` merely to use the PWA remotely.

Verify the exact address a second device will use (the check is read-only):

```bash
./scripts/oakridge-browser-smoke http://<machine-ip-or-tailnet-name>:8788
```

When token authentication is enabled, leave `OAKRIDGE_CONTROL_TOKEN` exported
for the smoke command. It checks the PWA shell, integration config, workflow
definitions, and review inbox through the same-origin kbbl proxy.

For final browser proof, load the URL on the second device and confirm **Runs**,
**Review inbox**, and **Workflows** all render without an "oakridge-core not
configured" banner. The smoke command proves reachability and proxy wiring;
this short visual check proves that the built JavaScript bundle can render in
the target browser.

Use the separate commands below when debugging either service.

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

**Which of these are legal depends on the runtime, and kbbl is the authority.**
Each kbbl adapter declares its own effort levels and publishes them on kbbl's
`/config` — today `claude-code` accepts `low`–`max` and `codex` accepts
`minimal`–`max`, so `minimal` is *not* valid for a claude-code session. The New
Run form's effort picker is populated from that endpoint, so it only ever offers
levels the selected runtime accepts.

oakridge-core deliberately keeps no effort allowlist of its own: it resolves
`effort` and forwards it verbatim, exactly as it does `model`, and kbbl rejects
an unsupported pair at session create. A core-side copy of this list previously
existed, went stale against `xhigh`/`max`, and failed valid runs — which is why
the check is gone rather than merely widened.

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

The dev-flow workflow is a four-stage `delegated_session` pipeline. Its bundled
definitions preserve old runs while the newest definition carries the complete
operator workflow:

- `oakridge-core/examples/dev_flow.json` (version 1) runs one session per stage.
- `oakridge-core/examples/dev_flow_v2.json` (version 3) fans build and assessment
  out over the cohorts produced by the plan.
- `oakridge-core/examples/dev_flow_v4.json` (version 4) starts each
  assessor as soon as its build cohort completes and reuses that build worktree.
- `oakridge-core/examples/dev_flow_v5.json` (version 5) binds each
  stage's **runtime** from run context alongside its model and effort, so the
  planner and worker roles can target different runtimes.
- `oakridge-core/examples/dev_flow_v6.json` (version 6, default) adds
  configurable artifact actions, one-step spec/plan approval, manual build
  admission, cohort briefs, and explicit merge outcomes.

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

Each stage is a `delegated_session` with typed artifacts. In v6, spec and plan
have one `artifact_approval` step with `approve` and `request_revision`; each
build cohort has `artifact_approval` followed by `merge_confirmation`, whose
actions are `confirm_merged` and `closed_without_merge`. Version 1 retains the
implicit unit id `"0"` and single-session behavior.

In version 3, `plan_writer` emits a repository-bound `cohorts` array and `build` materializes one
unit per cohort. Each build unit has its own kbbl session, branch, worktree,
artifacts, gates, and PR metadata. A cohort starts only after all ids in its
`depends_on` list are `done`; independent cohorts may run concurrently, up to
the stage's `fan_out.max_parallel` limit. Dependencies control execution order
only: every build worktree uses the configured run base rather than a preceding
cohort's branch.

In version 4, the seeded `assessor` inherits the build fan-out by unit id. Each
assessor unit starts when its matching build unit is done, receives only that
cohort's `dev.build_result`, and runs in the completed builder's persisted
worktree. Assessment uses `planner_model` and `planner_effort`. Version 3 keeps
the earlier whole-build-stage barrier. A custom aggregate consumer can instead
declare `collect: true` on an input slot; it receives a deterministic
unit-id-ordered array of
`{ "unit_id": "...", "artifact_id": "...", "artifact": ... }` envelopes after
the producer stage is done.

In version 5, `runtime` is bound from run context per role — `planner_runtime`
for `spec_analyzer`, `plan_writer`, and `assessor`; `worker_runtime` for `build`
— rather than pinned in the definition. Through version 4 every stage pinned
`"runtime": "claude-code"` while the model was bound from context, so a run
launched with a codex model failed at session creation with
`unknown model for claude-code: <model>`. A model is only valid against the
runtime it was chosen from, so both now travel together.

Unlike `model` and `effort`, a bound `runtime` has **no default**: if the launch
context omits it, the stage fails at config-build time naming the missing
pointer, rather than silently running on the wrong runtime.

Version 6 retains those runtime bindings. Its build fan-out sets
`manual_admission: true`, so an eligible cohort waits for an operator after its
dependencies complete instead of starting immediately. Admission is durable
and idempotent; refreshing or retrying the same request does not start a second
session.

### Role context keys

| Key | Consumed by | Required |
| --- | --- | --- |
| `planner_runtime` | `spec_analyzer`, `plan_writer`, `assessor` | yes (v5/v6) |
| `planner_model` | same | no — falls back to the runtime default |
| `planner_effort` | same | no — falls back to the runtime default |
| `worker_runtime` | `build` | yes (v5/v6) |
| `worker_model` | `build` | no — falls back to the runtime default |
| `worker_effort` | `build` | no — falls back to the runtime default |

### Prerequisites

- kbbl and oakridge-core running (see earlier sections).
- One or more local Git checkouts supplied when the run is created.
- `OAKRIDGE_PROMPTS_DIR` pointed at `oakridge-core/prompts` (or started from the
  `oakridge-core/` directory where `./prompts` is the default).

### Select the workflow definition

oakridge-core seeds the bundled dev-flow definitions on startup. In the kbbl
PWA, choose **New Run** and select `dev-flow v6` (the newest version is selected
by default). The Planner and Worker pickers each choose a runtime, a model, and
an effort; all three are sent with the run.

Older versions are retired automatically when a new built-in version is first
seeded, so only v6 appears in the picker. They are archived, not deleted — every
existing run still resolves its definition. To bring one back, tick **Show
retired** on the Workflow Definitions screen and choose **Restore** (or
`POST /workflow_defs/:id/unarchive`); the seed will not re-retire it on later
boots. Note that v1/v3/v4 pin `runtime: claude-code`, so a restored version
still fails if you pair it with a codex model.

The API command below is only needed when loading a modified or custom copy of
the example. Posting the unchanged built-in again conflicts with its seeded
name and version.

```bash
CORE=http://127.0.0.1:8790

curl -sX POST "$CORE/workflow_defs" \
  -H 'content-type: application/json' \
  -d "$(jq '{name,version,graph}' oakridge-core/examples/dev_flow_v6.json)"
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
      \"repositories\": [
        {\"key\": \"api\", \"path\": \"/abs/path/to/api\"},
        {\"key\": \"web\", \"path\": \"/abs/path/to/web\"}
      ],
      \"oakridge_url\": \"http://127.0.0.1:8790/\",
      \"planner_runtime\": \"claude-code\",
      \"planner_model\": \"claude-opus-5\",
      \"planner_effort\": \"high\",
      \"worker_runtime\": \"claude-code\",
      \"worker_model\": \"claude-sonnet-5\",
      \"worker_effort\": \"high\"
    }
  }"
```

`brief_notes` and the complete keyed repository list are passed into the
`spec_analyzer` and `plan_writer` prompts. Each planned cohort selects one key.

`planner_runtime` and `worker_runtime` are required by versions 5 and 6 — omitting
either fails the corresponding stage at config-build time. Drop all six
role keys when running the version 1 or 3 definitions, which pin their runtime.

### Complete v6 operator workflow

Use the PWA for the normal path; the API remains available for automation.

1. Open the emitted `dev.spec_analysis` from the run or **Review inbox**. Read
   the discrepancy sections, add/resolve required review items, then choose
   **Approve**. Choose **Request revision**, include actionable feedback, and
   review the newly emitted child revision when the analysis is incomplete.
   Approval always targets the displayed latest revision; a stale tab is
   rejected.
2. Review `dev.plan` the same way. The plan viewer shows cohort briefs and real
   `depends_on` edges. Approve only when repository keys, scope, dependencies,
   decisions, and acceptance criteria are correct. This is a one-step gate;
   approval materializes build units exactly once.
3. Open **Review inbox**. A build cohort appears as **Waiting for admission**.
   Inspect its brief and blockers. **Admit build** is offered only after every
   dependency is complete. Admission starts that cohort's kbbl session and
   worktree; independent eligible cohorts may be admitted in parallel.
4. Follow the cohort through **Building** to **Artifact review**. Open its
   artifact, review the descriptor-selected sections and any discussion or
   checklist items, then choose **Approve** or **Request revision**. Revision
   feedback returns to the same delegated session; review the latest child
   artifact before approving.
5. At **Merge confirmation**, inspect the displayed PR URL, branch, and
   worktree. After the external PR operation, record **Confirm merged** or
   **Closed without merge**. Either explicit terminal outcome completes the
   build cohort and releases eligible dependents; Oakridge never merges the PR
   itself.
6. The matching assessor starts from the completed builder worktree. Track
   **Assessing** and final **Done** state in **Review inbox**. The cohort card
   separately reports build and assessment completion. When every cohort and
   assessment is complete, the workflow run reaches `done`.

Gate mutations include a client-generated idempotency key, exact artifact
revision, gate step, action, comment, and optional feedback. Durable pending
decision records allow a retry after a process interruption to reconcile the
already-applied transition rather than duplicate it.

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
below). A pending manually admitted build unit includes its cohort brief,
dependency blockers, and **Admit build** action.

### Review inbox (`#oakridge/review-inbox`)

This is the cross-run operator queue. **Needs attention** combines eligible
build admissions, artifact gates, merge decisions, blocked cohorts, and failed
cohorts. Artifact items link straight to the review page; admission items can
be admitted in place. **Cohort lifecycle** tracks every cohort through Waiting
for admission, Building, Artifact review, Revision requested, Merge
confirmation, Assessing, Done, or Failed, with separate build and assessment
completion indicators.

### Parked gate panel

When any stage in the run is parked, the gate panel renders below the stage
table. Each parked gate shows:
- Gate type (artifact approval vs. merge confirmation)
- Stage name and artifact revision id
- Worktree branch and path (when present) — **read before approving a
  merge-confirmation gate**
- Only the actions configured for the current step: **Approve** / **Request
  revision**, or **Confirm merged** / **Closed without merge** in dev-flow v6

The `id` field on each gate returned by `GET /parked` and `GET /runs/:id/gates` is a
**composite gate id** with the form `"{stage_instance_uuid}:{unit_id}"`. For a
stage without `fan_out` this is `"{uuid}:0"`; for a fanned stage — including a
fan-out containing one item — the suffix is the materialized unit id. Pass this
composite id when calling
`POST /gates/:id/resume` directly via curl:

```bash
# composite_id is the "id" field from GET /parked (e.g. "abc...def:0")
curl -sX POST "$CORE/gates/<composite_id>/resume" \
  -H 'content-type: application/json' \
  -d '{
    "idempotency_key": "<new-uuid-retained-for-retries>",
    "artifact_revision_id": "<exact-displayed-revision-id>",
    "gate_step": "artifact_approval",
    "action": "approve",
    "operator_comment": "Reviewed the artifact and worktree",
    "feedback": null
  }'
```

The `unit_id` suffix is `"0"` for every stage that does not have a `fan_out` config.

### Artifact inspection (`#oakridge/artifact/<id>`)

The descriptor-driven review shell selects a registered spec, plan, build,
PR-summary, or assessment viewer and falls back to JSON for unknown types. It
shows configured sections in order, revision history, comments, review-item
checklists, and the matching gate actions on the artifact itself. Navigate here
from stage artifact chips or directly from **Review inbox**. Gate actions target
the latest displayed revision and reject stale revision or gate-step requests.

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

Gates returned by `GET /parked` and `GET /runs/:id/gates` carry a composite `id`
of the form `"{stage_uuid}:{unit_id}"`. A stage without `fan_out` uses
`"{uuid}:0"`; any fanned stage uses its materialized unit id, even when it has
only one item. The `POST /gates/:id/resume` route parses this composite id to
route the decision. See the "Parked gate panel" section.

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

## Deliberate boundaries

The runnable v2 operator flow still leaves these operations outside Oakridge:

- **PR merge** — the seeded v2 build agent opens one PR per cohort and emits a
  `dev.pr_summary`; oakridge-core surfaces the matching PR URL and worktree at
  the unit's merge-confirmation gate. The operator completes the merge itself.
- **Full epic lifecycle management** — v1 Epics carry archive, delete, and status
  transitions. v2 uses workflow runs and cohort lifecycle states rather than a
  separately named Epic entity.
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
