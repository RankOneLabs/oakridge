# Workflow configuration

`src/development.ts` builds both pinned example bundles from one Rust-generated
TypeScript source contract. Run `bash scripts/generate-bundles.sh` after editing
the builder; CI runs it with `--check`.

`definitions/development.json` is an example pinned scope bundle.
`definitions/development-independent-siblings.json` illustrates independent
sibling work after a child failure and a shared implementation capacity of two.
The bundle declares workflow names, commands, stages, review paths and output
contracts. The Rust interpreter evaluates those declarations without branching
on a workflow name.

`definitions/development-contract.md` documents the example bundle. Each prompt
declares `key`, repository-relative `path`, `input_schema`, and the SHA-256
`content_digest` of the file's exact bytes. The server resolves each path under
`OAKRIDGE_PROMPT_ROOT` (default: repository root), permits only
`workflow-config/prompts/`, rejects traversal and symlinks escaping that root,
and verifies the digest before pinning. It repeats the check before rendering
an execution prompt. The generated JSON is the source sent to `/api/definitions`:
the server compiles its parsed fields unchanged, so Rust's canonical digest
identifies the same authored artifact. `JSON.stringify(bundle, null, 2) + "\n"`
reproduces its bytes. Prompts under `prompts/dev-flow/` receive pinned action
inputs and selected publication authority from the runtime.
