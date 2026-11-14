# Workflow configuration

`development.yaml` defines shared decision sets and worker and review templates.
Stages can bind expressions with `let`, and unit dependencies follow the outcomes
their inputs read. A collection can sit beside other units in its group.

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

## Task contracts in the development workflow

Plan cohorts retain `task_acceptance { id, text, decision_ids }`, allocating approved tasks. Briefs carry `build_items { id, description, task_ids, decision_ids, verification }` as the standalone implementation contract. Items can split a task or span several tasks.

Separate brief validate checks enforce unique item ids, coverage of every allocated task, no task outside that allocation, nonempty descriptions, at least one task per item, and decision links resolving in the brief's decisions_made. Cohort identity, repository and dependency checks remain. Structural checks do not establish semantic completeness.

Assessment findings carry `subjects { kind: build_item | task, id, cohort_id? }`, optional status, evidence and description. Cohort checks require build_item subjects resolved in the brief, every brief item addressed, and head_sha matching the latest build result. Findings with `subjects: []` are valid for cross-cutting concerns. A failed check retains the revision and feedback, refuses approval and leaves request changes available; no synthetic finding is created.

Integration receives only the repository's applicable briefs. Task subjects must resolve in their build items' task_ids; build_item subjects must name a cohort and an item in that cohort's brief. Repeated task ids across cohorts represent one task. Integration has no every-item-addressed rule; validation failures auto-return feedback to the integrator. Verdict, test evidence and recommended next actions remain unchanged.

## Definition store

The generator also writes the committed definition store under `definitions/`:

- `workflows/<definition_id>.json` carries the authored source, one
  `operation_registry_id`, a prompt-path-to-PromptId map, and ordered
  `schema_names` and `stage_names` arrays.
- `prompts/<prompt_id>.md` copies exact authoring bytes, including line endings.
- `operations/<operation_registry_id>.json` carries the operation registry.
- `launchable.json` maps the authoring labels `review-loop`, `fan-out`, and
  `development` to definition IDs. Labels and source paths are lookup keys;
  only the definition ID identifies a workflow.

All IDs are unprefixed lowercase 64-hex SHA-256 strings. JSON objects use the
shared `canonical-json` package's `canonicalJson()` UTF-8 bytes, without a trailing
newline; prompts hash their exact file bytes. The root `.gitattributes` disables
line-ending conversion for authored prompts and their store copies, so checkout
settings cannot change those identity inputs. Every file under `prompts/` is
copied; each workflow pins exactly the paths named in its shared declarations,
workers, reviews, and template overrides.

Authored order is captured from YAML mapping nodes before conversion to JavaScript
objects, whose enumeration would sort integer-like names such as `"2"` and `"1"`.
This order is retained through canonicalization: reordering
`schemas:` or `stages:` changes the corresponding ordered array and therefore the
definition ID. This preserves the author's schema and stage list order for later
consumers. Other mappings, including a stage's `workers:` and an `input:` record's
fields, have no order array: reordering their keys preserves identity. Changing
any pinned prompt bytes or operation registry content changes the definition ID.

`src/definition-store.ts` resolves a definition ID, or an authoring label through
the launchable catalog, into `ResolvedDefinition`. At the file boundary it checks
UTF-8, raw byte hashes, canonical JSON, object shapes, ordered name membership,
and all transitive prompt and registry references. It returns `hash_mismatch`,
`malformed_object`, `invalid_utf8`, `missing_prompt`, or
`missing_operation_registry` failures, each with operation, identifier, and detail;
other filesystem errors return `store_io`. It does not normalize or repair data
and never falls back to today's registry or prompt authoring files.

Run `bun workflow-config/src/generate.ts` to generate the store and update the
launchable catalog. Historical definitions that decode under the current source
schema are retained byte-for-byte, alongside historical prompts and operation
registries. Every retained workflow object is checked with `isCommittedDefinition`,
which uses the generated `decodeWorkflowSource` matcher. Objects that fail this
check are removed during generation; pinned objects are never rewritten to migrate
them. Read failures stop generation before any stored objects are changed.
`--check` reports differing or missing current output files and names every
non-decodable retained workflow object without writing or deleting anything.
The existing pretty-printed Rust bundle fixtures remain unchanged, and the source-less
`r5-cohort.json` fixture has no committed definition. Run `bun test
workflow-config/src` for the identity and store boundary tests; `bun run typecheck`
includes this package.
