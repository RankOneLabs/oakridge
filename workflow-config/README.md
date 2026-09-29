# Workflow configuration

Shared data for the TypeScript backend in `oakridge-dbos/`:

- `definitions/` contains versioned JSON workflow definitions. The current
  built-in seed loads `dev_flow_v15.json`; older definitions are retained for
  reference and compatibility tests, not automatically offered as new runs.
- `prompts/` contains Markdown templates. Each delegated stage declares a
  `prompt_matrix` keyed by session role and launch reason; template paths are
  relative to this directory.

CI compiles every definition into a versioned manifest and content-addresses
the complete prompt matrix. Prompt bundles are stored separately, so changing
a prompt produces a new bundle hash without changing the immutable workflow
definition version. A run pins that hash with its definition, adapter, and
artifact schema versions.

Definitions and prompts were moved unchanged from the retired Rust backend.
Keep definition IDs and versions immutable: stored runs must continue to use
the contracts they were launched with. This directory contains no executor
implementation; compilation and execution belong to `oakridge-dbos/`.

The backend and its tests resolve these paths relative to their source files,
independently of the shell's working directory.
