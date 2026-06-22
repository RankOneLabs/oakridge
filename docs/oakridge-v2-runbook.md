# Oakridge v2 Runtime Delegation Runbook

This guide shows how to run an Oakridge v2 workflow locally. Oakridge v2 uses
`oakridge-core` as the workflow orchestrator and delegates runtime execution to
the subsystem that owns that runtime.

The current implementation includes both delegated execution paths:

- `delegated_session` delegates interactive work to kbbl sessions.
- `delegated_lbc_run` delegates headless autonomous work to the legit-biz-club
  CLI bridge.

Use this guide when you want oakridge-core to create and run workflow stages.
For direct operator-created kbbl sessions, see `kbbl/README.md`.

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
  Code runtime, export `ANTHROPIC_API_KEY` before starting kbbl.
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

## Add A Prompt Template

`delegated_session` reads prompt templates from oakridge-core's prompts
directory. Keep the template path relative to that prompts directory.

Example template `stage.md`:

```markdown
Implement this task:

{{TASK}}

Emit the result artifact to oakridge-core when complete.
```

The delegated agent must eventually POST an artifact to:

```http
POST /executors/delegated_session/:stage_instance_id/emit/:output_name
```

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
polls kbbl events. The session is visible in the kbbl PWA.

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

The delegated agent emits the declared output artifact:

```bash
curl -sX POST "$CORE/executors/delegated_session/<stage_instance_id>/emit/out" \
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

The first pass moves the stage to merge confirmation. Approve again after the
operator confirms the change is merged or otherwise accepted:

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
valid `RESULT ` line, and emits one result artifact containing paths and
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
