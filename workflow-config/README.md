# Workflow configuration

The development workflow is `development.yaml` (part 2 §1, rescue spec R5):
prepare, analysis, planning, a brief per plan cohort, a cohort per brief built,
assessed and merged in dependency order, and an integration PR per
repository. Its prompts live under `prompts/development/`, and its six
artifact bodies are the named schemas the PWA picks its viewers by
(`analysis_body`, `plan_body`, `brief_body`, `build_body`,
`assessment_body`, `pr_body`).

The v2 examples are authored in `samples/review-loop.yaml` and
`samples/fan-out.yaml`. `bun workflow-config/src/generate.ts` parses every
workflow listed in `src/workflow-sources.ts`, the samples and development,
with the workspace's `yaml` package and writes their JSON counterparts to
`workflow-core/fixtures/bundles/`, which the Rust compiler and replay tests
and the DBOS end-to-end tests use. Run `bun workflow-config/src/generate.ts
--check` to detect drift; CI runs this check. The prompts referenced by the
samples live under `prompts/review-loop/` and `prompts/fan-out/`, and the Rust
sample tests load those exact files.

`src/prompt-catalog.ts` lists every file under `prompts/` with a server-computed
SHA-256 digest; the authority serves it at `/api/prompts` and resolves a pinned
bundle's prompt keys through it.

The PWA's definition editor authors a workflow source as JSON; the authority
compiles it against these prompts and pins it.
