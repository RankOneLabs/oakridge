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

The revised specification contains the canonical **Spec tasks** section, with stable ids, descriptions and explicit requirement links. The separate tasks artifact mirrors it exactly; task edits revise that section and republish both artifacts. The spec editor publishes the spec before tasks. The approved task list is the one source of identity for the work. A plan cohort
and a brief share the `task_acceptance` entry, exactly `{ id, text, decision_ids }`.
`id` is an approved task's id. No other id is allocated for an entry, and a task
spanning cohorts keeps the same id in each, so `T7` is `T7` in cohorts A and B.
Tests, typechecks and process milestones are verification, not entries.

Declared `validate` checks enforce this on publication:

- A plan's entries name only approved tasks, every task appears in at least one
  cohort, and no id repeats within a cohort. Repeating an id across cohorts is valid.
- A brief's ids equal its plan cohort's ids in the same order, beside its
  `cohort_id`, `repository_key` and `depends_on` checks. Its text may change;
  prompts and review enforce that the obligation survives.

The checks use the generic `flatten(list_of_lists)` and `unique(list)` expressions.
A failed check keeps the revision and its feedback, and the Rust authority then
refuses any approve decision on that revision and stops offering one. Request
changes stays available, and a corrected revision is judged on its own publication.
Record types are open, so an undeclared field on a body is ignored rather than
refused; the checks read only declared fields.

An `assessment_finding` carries a required `task_ids` list, with a narrow
`description`, `status` (`met`, `not_met`, `partial`) and cited `evidence` (`file`,
`test`, `output`). One task may have several findings, one finding may list several
tasks, and `task_ids: []` marks an unlinked finding. Verdicts and statuses are
workflow assessment values, not grades, and no task link gates grading.

Integration's `briefs` input is every brief whose `repository_key` equals the
integration repository's `key`. The integrator groups entries by id, reads every
cohort's contribution to a shared task and assesses each distinct task on the
integration branch. An integration assessment has no build result subject.

## Definition store

The generator also writes the committed definition store under `definitions/`:

- `workflows/<definition_id>.json` carries the authored source, one
  `operation_registry_id`, a prompt-path-to-PromptId map, and ordered
  `schema_names` and `stage_names` arrays plus an `artifact_names` map whose arrays
  retain each stage’s authored artifact declaration order.
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
`schemas:`, `stages:`, or a stage’s `artifacts:` changes the corresponding ordered
array and therefore the definition ID. This preserves the author's schema, stage
and artifact declaration order for later consumers. Other mappings, including a stage's `workers:` and an `input:` record's
fields, have no order array: reordering their keys preserves identity. Changing
any pinned prompt bytes or operation registry content changes the definition ID.
The artifact order map is required and must list every stage and each declared
artifact exactly once. Definitions without it are incompatible; regeneration
writes new definition IDs and removes incompatible stored objects.

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
