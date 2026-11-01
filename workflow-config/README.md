# Workflow configuration

`development.yaml` defines shared decision sets and worker and review templates.
Stages can bind expressions with `let`, and unit dependencies follow the outcomes
their inputs read. A collection can sit beside other units in its group.

The v2 examples are authored in `samples/review-loop.yaml` and
`samples/fan-out.yaml`. `bun workflow-config/src/generate.ts` parses every
workflow listed in `src/workflow-sources.ts`, the samples and development,
with the workspace's `yaml` package and writes their JSON counterparts to
`workflow-core/fixtures/bundles/`, which the Rust compiler and replay tests
and the DBOS end-to-end tests use. Run `DEFINITIONS_MERGE_BASE=origin/main bun
workflow-config/src/generate.ts --check` to detect drift and verify committed
store objects against the merge base; this requires local branch history. CI
runs this check. The prompts referenced by the
samples live under `prompts/review-loop/` and `prompts/fan-out/`, and the Rust
sample tests load those exact files.

`src/prompt-catalog.ts` lists every file under `prompts/` with a server-computed
SHA-256 digest; the authority serves it at `/api/prompts` and resolves a pinned
bundle's prompt keys through it.

The PWA's definition editor authors a workflow source as JSON; the authority
compiles it against these prompts and pins it.
