# Workflow configuration

Shared data for the TypeScript backend in `oakridge-dbos/`:

- `definitions/` contains versioned JSON workflow definitions. The current
  built-in seed loads `dev_flow_v14.json`; older definitions are retained for
  reference and compatibility tests, not automatically offered as new runs.
- `prompts/` contains Markdown templates. Definition `prompt_template_path`
  values are relative to this directory, including `dev-flow/` and `collab/`.

Definitions and prompts were moved unchanged from the retired Rust backend.
Keep definition IDs and versions immutable: stored runs must continue to use
the contracts they were launched with. This directory contains no executor
implementation; compilation and execution belong to `oakridge-dbos/`.

The backend and its tests resolve these paths relative to their source files,
independently of the shell's working directory.
