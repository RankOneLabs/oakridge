# Workflow configuration

`definitions/dev_flow_v15.json` mirrors the canonical six-stage definition in
`docs/v15-contracts/`. The built-in loader and compiler validate this authored
format directly. Each worker declares named action points and exact typed input
bindings; provisioning declares an operation instead of an LLM prompt.

The eighteen LLM action points each reference a distinct Markdown file under
`prompts/dev-flow/v15/`. Paths in the definition are relative to the repository
root. The compiler loads every referenced file, rejects missing or empty prompts,
and content-addresses the complete prompt bundle. Definition versions are
immutable; changing prompt content produces a separate bundle hash.

B1 provides the contracts, configuration, compiler, and immutable storage path.
Stage initialization explicitly returns unimplemented until B4 provides the
named materialization functions. The remaining runtime work and deployment
cutover belong to later briefs; this branch is not deployed during its run.

Historical graph inputs used to test the remaining engine are isolated under
`oakridge-dbos/tests/support/`. They are not a production loader fallback.
