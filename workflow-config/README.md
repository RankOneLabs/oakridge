# Workflow configuration

Shared data for the TypeScript backend in `oakridge-dbos/`:

- `definitions/` contains the current JSON workflow definition. The built-in
  seed loads `dev_flow_v15.json`. Superseded files are removed because CI
  compiles every definition in this directory against the current schema.
- `prompts/` contains Markdown templates. The v15 dev-flow matrix lives under
  `prompts/dev-flow/v15/` and has one file for every `(stage, session role,
  launch reason)` cell. Template paths are relative to this directory; a
  launch reason never shares a prompt through conditional template text.

CI compiles every definition into a versioned manifest and content-addresses
the complete prompt matrix. Prompt bundles are stored separately, so changing
a prompt produces a new bundle hash without changing the immutable workflow
definition version. A run pins that hash with its definition, adapter, and
artifact schema versions.

Keep a shipped definition ID and version immutable. Historical definitions
remain in database rows for runs pinned to them; removing their source files
from this compile directory does not mutate those rows. This directory contains
no executor implementation; compilation and execution belong to
`oakridge-dbos/`.

The backend and its tests resolve these paths relative to their source files,
independently of the shell's working directory.
