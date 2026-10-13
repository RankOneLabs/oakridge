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

The v1 template authoring surface and its bundle builder are retired, along
with the per-stage scope and schema modules they composed. The bundles under
`definitions/` are the last of its output and are now committed as pinned test
inputs for the DBOS and PWA suites that have not been cut over yet. Nothing
regenerates them, and nothing should: whichever cohort moves those consumers
onto the v2 compiler and the YAML samples above deletes the bundles with them.
`prompts/templates/` and `prompts/dev-flow/` are frozen for the same reason
-- the renderer that composed `dev-flow/v3/` from the templates is retired,
and `prompts/development/` replaces them for the v2 workflow. They go with
the PWA fixtures that still read them (rescue spec R6).
