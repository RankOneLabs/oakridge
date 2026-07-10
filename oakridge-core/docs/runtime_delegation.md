# Runtime Delegation

`oakridge-core` ships two distinct delegated execution paths:

- `delegated_session` for interactive, operator-visible kbbl sessions.
- `delegated_lbc_run` for headless legit-biz-club process bridging.

They are not replacements for one another. They cover different execution modes and
own different runtime responsibilities.

## `delegated_session`

`delegated_session` is the existing interactive delegation path. `oakridge-core`
creates and tags a kbbl session, sends the rendered prompt, and keeps the live session
visible to the operator.

The stage uses kbbl as the runtime owner:

- `runtime: "claude-code"` starts a Claude Code kbbl session.
- `runtime: "codex"` starts a Codex kbbl session, if Codex is enabled in kbbl.

Workflow completion remains domain-driven:

1. The delegated agent emits an artifact to
   `POST /executors/delegated_session/:stage_instance_id/emit/:output_name`.
2. `oakridge-core` parks the stage for artifact approval.
3. A needs-changes `GateDecision` is forwarded to the same live kbbl session with
   `POST /:sid/input`.
4. A passing artifact-approval `GateDecision` advances to merge confirmation.
5. A passing merge-confirmation `GateDecision` marks the stage `done` and tears down
   the kbbl session with `DELETE /sessions/:sid`.

The workflow node stays in the regular graph shape:

```json
{
  "stage_type": "delegated_session",
  "config": {
    "runtime": "claude-code",
    "prompt_template_path": "stage.md",
    "slot_bindings": {
      "TASK": { "from": "input", "input_name": "task", "path": "/summary" }
    },
    "workdir": { "from": "context", "path": "/workdir" },
    "session_name": "stage name",
    "model": null,
    "pre_authorized_tools": [],
    "yolo": false
  },
  "inputs": [{ "name": "task", "artifact_type": "text", "optional": false }],
  "outputs": [{ "name": "out", "artifact_type": "text" }]
}
```

`KBBL_API_BASE_URL` is process config, not per-stage config. `prompt_template_path` is
resolved relative to `OAKRIDGE_PROMPTS_DIR`.

### `pre_authorized_tools` policy

`pre_authorized_tools` is present in `DelegatedSessionDefConfig` for contract stability,
but any non-empty value is **rejected at `build_config` time** with:

```
pre_authorized_tools is not supported: per-tool approval is managed by the kbbl PWA (Phase 2).
Remove pre_authorized_tools from the workflow definition or set it to an empty array.
```

This rejection is deliberate. Tool preauthorization is a **Phase 2** feature: the kbbl
PWA owns per-tool approvals interactively. Baking a tool allowlist into the workflow
definition would bypass the PWA approval surface before that surface is built. All
first-party workflow definitions (including `examples/dev_flow.json`) use:

```json
"pre_authorized_tools": []
```

If you need unblocked execution for a stage today, set `"yolo": true` instead.

## `delegated_lbc_run`

`delegated_lbc_run` is the headless legit-biz-club bridge for autonomous work, study
cells, ensemble runs, grading, and jig-backed execution. `oakridge-core` owns the
workflow orchestration and spawns the external LBC process; LBC owns the runtime internals
inside the bridge process.

The workflow node binds a run spec and an output slot:

```json
{
  "stage_type": "delegated_lbc_run",
  "config": {
    "task": { "from": "literal", "value": "prose_substrate_thesis" },
    "model_pool": { "from": "literal", "value": ["claude-sonnet-4-5"] },
    "condition": { "from": "literal", "value": { "kind": "single_agent", "n": 1 } },
    "grade": { "from": "literal", "value": true },
    "output_dir": { "from": "context", "path": "/workdir" },
    "bridge_command": "uv",
    "bridge_args": ["run", "python", "-m", "legit_biz_club.run"],
    "result_output_slot": "result"
  },
  "inputs": [],
  "outputs": [
    { "name": "result", "artifact_type": "prose" }
  ]
}
```

Notes:

- `output_dir` is the LBC study root passed to the CLI.
- `bridge_command` defaults to `uv`.
- `bridge_args` default to `["run", "python", "-m", "legit_biz_club.run"]`.
- `result_output_slot` is declared on the workflow output slot and looked up by name;
  the executor does not hard-code the artifact type.

The bridge is invoked as:

```sh
uv run python -m legit_biz_club.run --spec <spec.json> --output-dir <dir>
```

The LBC CLI prints a single authoritative `RESULT ...` line on stdout when it finishes.
`oakridge-core` parses that line, then emits the artifact with a body shaped like:

- `artifact_path`
- `output_dir`
- `run_spec_path`
- `run_spec`
- `eval_scores`
- `sidecars`

`sidecars` is discovered under `cell_output_dir`, where `cell_output_dir` is derived from
`artifact_path.parent`. The executor looks for:

- `cell_output_dir`
- `events_jsonl_path`
- `eval_scores_json_path`
- `commits_dir`

This keeps `output_dir` as the study root while still attaching per-cell sidecar paths to
the emitted artifact.

## Recovery states for `delegated_session`

When `oakridge-core` recovers a `delegated_session` stage on boot, it selects
the recovery path from the persisted configuration and session-unit rows.
Definitions without `fan_out` retain the N=1 stage-level behavior. Fanned N>1
stages rebuild their complete unit graph, reattach each durable session
independently, leave done units untouched, and admit dependency-ready pending
units after reconstruction.

### `waiting_for_kbbl`

**When**: a recovered stage has an `external_ref` (kbbl session ID from a prior
process lifetime), but kbbl is unreachable at boot time — connect failure, timeout,
or a 5xx response.

**N=1 state**: stage status `parked`,
`parked_reason = "waiting_for_kbbl"`,
`parked_meta = {"kind": "waiting_for_kbbl"}`.

**N=1 behaviour**: a background retry task polls kbbl at the scheduler cadence
(5 s in production). When kbbl becomes reachable:

- If the stage was `Running` before the park: status returns to `Running`,
  `parked_reason` and `parked_meta` are cleared, and the normal observer loop
  starts.
- If the stage was `Parked` at a gate before the park: status returns to `Parked`
  with the original `parked_reason` and `parked_meta` restored, and the observer
  loop starts.

If kbbl responds with a terminal error (4xx, non-retryable) during retries, the
stage is failed with `terminal_meta = {"reason": "..."}`.

**N>1 behaviour**: recovery probes every running or parked unit that has an
`external_ref`. A temporarily unreachable running unit is parked with an
internal recovery marker that preserves its previous status and gate state;
an already gate-parked unit keeps its gate. Each affected unit retries kbbl
attachment independently. When kbbl returns, the prior unit state is restored
and its observer is reattached exactly once. Healthy siblings continue, and
the parent stage status is derived from all unit rows.

A non-retryable response fails only the affected unit with terminal metadata.
The aggregate stage parks with `parked_reason = "unit_attention_required"`
while other eligible units continue.

**Operator action**: none required — attachment retries automatically. If a
stage or unit stays in the waiting state for an extended period, check kbbl
health.

### `session_ended_without_emit`

**When**: the kbbl observer detects `subprocess_exited` with `code: 0` while the
stage is still `Running` (no artifact has been emitted yet). This happens when the
delegated agent exits cleanly without calling the emit route.

**N=1 state**: stage status `parked`,
`parked_reason = "session_ended_without_emit"`,
`parked_meta = {"kind": "session_ended_without_emit"}`.

**N=1 behaviour**: the stage is not completed and not failed. The operator must
inspect it and decide whether to fail the stage or supply an artifact
out-of-band; whole-stage retry remains limited to `stuck_timeout`.

**N>1 state and behaviour**: only the affected unit becomes `failed`, with
`terminal_meta = {"kind": "session_ended_without_emit"}`. The aggregate stage
parks with `parked_reason = "unit_attention_required"`, while unaffected
siblings continue. Retry that unit without disturbing siblings:

```http
POST /stage_instances/:id/retry_stuck
Content-Type: application/json

{ "unit_id": "<unit-id>" }
```

The retry preserves the materialized parameters, dependency list, worktree
identity, and historical artifact revisions. It clears the previous attempt's
session, gate, and current-artifact routing state, then re-admits the unit
through the normal dependency and `max_parallel` checks.

If the stage is already `Parked` at a gate (artifact already emitted) when the
clean exit arrives, the exit is expected — the observer stops but the live session
remains intact so the pending gate decision can still be delivered.

**Operator action**: inspect the kbbl session transcript to determine why the
agent exited without emitting an artifact. For N>1, retry the named unit only
after correcting the cause.

### Recovery failures: structured `terminal_meta`

Two failure kinds can appear on stages recovered from DB:

| `terminal_meta.kind` | Cause |
|---|---|
| `recovery_unregistered_stage_type` | The stage's `stage_type` is not registered in the runtime's stage-type registry. The stage cannot be re-executed. |
| `recovery_missing_stage_key` | The stage's `stage_key` does not appear in the current workflow graph definition. The stage row is orphaned. |

Both result in `StageStatus::Failed` with `terminal_meta` containing `kind`,
`stage_key`, and (for unregistered type) `stage_type`. The run is also marked
`Failed`. No operator intervention can recover these — they indicate a
misconfiguration or a schema mismatch between the DB and the deployed code.

## Terminal metadata

`delegated_lbc_run` uses `terminal_meta` as the failure and terminal context surface.
The run is marked `failed` for the following cases:

- spawn failure
- non-zero exit
- missing `RESULT`
- invalid `RESULT` JSON
- invalid `RESULT` payload
- artifact emission failure
- cancellation, which is mapped to `failed`
- unexpected internal error — the outer catch-all (`kind: "runtime_error"`) for IO
  failures, a closed channel, or anything not covered by a structured kind above

On success, `terminal_meta` records the command, args, output directory, run-spec path,
PID when available, and output tails. `parked_reason` remains the parked-only surface and
is not repurposed for terminal diagnostics.

## Real CLI smoke test

`oakridge-core/tests/delegated_lbc_run_smoke.rs` is an ignored, opt-in smoke test that
can be run when dependencies, `uv`, and provider credentials are available.

The test invokes the real bridge entrypoint:

```sh
uv run python -m legit_biz_club.run --spec <spec.json> --output-dir <dir>
```

It then checks that stdout contains a valid `RESULT` line and that the parsed payload
still matches the executor contract.

Set `OAKRIDGE_RUN_REAL_LBC_SMOKE=1` to enable the test body when running ignored tests.

## Run cancellation

`POST /workflow_runs/:id/cancel` requests cancellation of an active run.

### Response

| Field | Type | Description |
|---|---|---|
| `run_id` | UUID | The run that was targeted |
| `accepted` | bool | `true` if cancellation was initiated; `false` if the run was already terminal |
| `stages_cancelled` | u64 | Count of stage instances transitioned to `Failed` by this request |

Returns `202 Accepted` when `accepted = true`, `200 OK` when `accepted = false`.
Returns `404` if the run ID does not exist.

### Stage transitions

All stage instances in `pending`, `running`, or `parked` status are transitioned to
`Failed` synchronously before the response is returned. The transitioned stages receive:

```json
{
  "kind": "cancelled",
  "reason": "run cancelled by operator"
}
```

as their `terminal_meta`. Parked stages are removed from the `GET /parked` listing
immediately upon cancellation.

### External process propagation

After persisting the DB state, a `ControlMsg::Cancel` is delivered to the active run
task (if one is still running). Each executor type handles cancellation:

- `delegated_session`: calls `DELETE /sessions/:sid` on kbbl and removes the session
  from the live-sessions map.
- `delegated_lbc_run`: signals the bridge monitor to kill the child process group and
  writes `terminal_meta` with `kind: "cancelled"`. Because the bridge also writes
  cancellation metadata, its write arrives after the bulk DB update but is idempotent
  on `kind`.

If no active run task is found but the run's DB status is still non-terminal, the run
status is updated to `Failed` directly.

### Recovery behaviour

`Failed` stage instances — including those with `kind: "cancelled"` — are treated as
terminal by `recover()`. They are never re-executed after a restart. No additional code
is required; the recovery path already skips `Done` and `Failed` stages.

### Idempotency

A second `POST /workflow_runs/:id/cancel` on an already-terminal run returns
`200 OK` with `accepted: false` and `stages_cancelled: 0`.

## Out of scope

This cohort does not add callback-based kbbl delegation, `POST /execution/sessions`, or
any replacement for polling/core-owned artifact emit routes.
