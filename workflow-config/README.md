# Workflow configuration

`src/development.ts` composes three pinned example bundles from the Rust-generated
TypeScript source contract. The bundles under `definitions/` are generated, not
committed: `bash scripts/generate-bundles.sh` renders the prompts and writes the
bundles, and every consumer runs it first. CI runs it with `--check`, which
fails when a rendered prompt differs from its committed file.

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
compare `generate-bundles.sh` output before and after to confirm it.

`definitions/development.json` is an example pinned scope bundle.
`definitions/development-independent-siblings.json` illustrates independent
sibling work after a child failure and a shared implementation capacity of two.
`definitions/development-verification.json` adds a verification stage, uses
alternate contract field ordering, and sets implementation capacity to three.
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

An apply leaf whose only evaluated mutations assign the current state again,
with no worker action or terminal outcome, evaluates to `Wait` and awaits a new
trigger. It does not commit a duplicate transition. Value copies and equality
checks consume the bundle's `evaluation_budget`; exhaustion returns a resource
limit error before the operation runs. Provider calls use each selected
action's pinned `deadline_ms`; a timed out or rejected session delivers
declared failure evidence so the bundle's sibling policy decides the next
branch. Operator cancellation follows the root `cancel` command and declared
child cancellation mutations.

The DBOS application version is derived from the sorted engine source manifest,
the authority baseline SQL digest and the running core binary, independently of
bundle and prompt changes. A changed bundle is pinned by its own compiler digest and does not
change which existing DBOS workflows can resume.
