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
resolved relative to `OAKRIDGE_PROMPTS_DIR`. `pre_authorized_tools` is present for the
future kbbl allowlist contract, but it is inert today.

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

## Out of scope

This cohort does not add callback-based kbbl delegation, `POST /execution/sessions`, or
any replacement for polling/core-owned artifact emit routes.
