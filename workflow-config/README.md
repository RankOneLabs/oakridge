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

Authored YAML mapping order is captured before canonicalization: reordering
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

Run `bun workflow-config/src/generate.ts` to generate the store and remove obsolete
generated objects. `--check` reports the differing, missing, or stale output file
without writing. The existing
pretty-printed Rust bundle fixtures remain unchanged, and the source-less
`r5-cohort.json` fixture has no committed definition. Run `bun test
workflow-config/src` for the identity and store boundary tests; `bun run typecheck`
includes this package.
