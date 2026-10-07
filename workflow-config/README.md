# Workflow configuration

`src/development.ts` composes both pinned example bundles from the Rust-generated
TypeScript source contract. Run `bash scripts/generate-bundles.sh` after editing
the authored configuration; CI runs it with `--check`.

The maintained source has three layers:

- `src/primitives/` contains reusable constructors for schema fields, records,
  literals, references, optional values and variants. They return the existing
  Rust source types, without introducing another configuration language.
- `src/development/schemas/` groups shared schemas by domain. Each directory
  under `src/development/stages/` owns a stage's declarations, worker actions
  and named decision nodes. Larger graphs are grouped by the events they handle.
- `src/development/policies.ts` names each run's capacity and sibling failure
  policy. `src/development.ts` composes the schemas, stages, prompts, operations
  and resource limits; `src/development/run/` declares the root scope's children,
  dependencies and completion decisions. Change `implementation_capacity` to adjust admission;
  change `sibling_failure` to select cancellation or independent continuation.

The independent-siblings example also uses alternate field ordering to exercise
provider decoding. That contract variation is separate from failure policy and
selects schema fields, workers and command cases by name, never array position.

Declaration order and object field order contribute to the serialized pinned
bundle. Refactoring the authoring source should leave generated bundles unchanged;
an intentional behavior change requires regenerating and reviewing their diff.

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
