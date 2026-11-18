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

## Development contract

Analysis extracts canonical requirement ids with source references and nested,
evidence-backed findings. The analysis accept guard rejects blocking findings and
unchosen operator decisions. The editor normalizes only approved resolutions into
one structured specification, preserving requirement ids, source links and
observable acceptance conditions. There is no separate work-list artifact or gate.

Planning allocates requirements to PR-shaped cohorts with bounded contributions,
repository keys and an acyclic depends_on graph. Oakridge resolves each writer's
assignment to its cohort and only its allocated canonical requirements. Briefs
bind their envelope to that plan cohort and supply detailed build_items linked to
requirements, verification and material technical_decisions. Implementation order
and outcome titles come from the plan.

Cohort and integration assessments share one schema: item_assessments,
additional_findings, audience-specific source-linked next_actions, required test
evidence and a mechanically checked verdict. Cohorts assess each build item;
integration assesses each distinct canonical requirement once across contributions.
The assessment review records typed adjudication (accepted, modified or rejected
actions, operator additions and builder_feedback). Only builder_feedback reaches
the builder or integrator; assessors read the full implicit review_history. Every
initial/revise prompt directs the agent to raise a blocker instead of guessing.

The development alias now pins definition
`110fde45d5fa48998cff802f8527bf2e130e7a8feb9d22d074f08f183290f505`.
The previous definition
`74de304c8c29fc50ac3596817a2aed2ffb14846ccb8ecb7ef59f91127b7f87f4`
and its exact prompt objects remain addressable.

Current `artifact_schema_version` values, calculated by the observation adapter
from the compiled artifact declarations:

| Artifact | Schema version |
| --- | --- |
| analysis | `artifact-schema/v1:4847489074cebfe24f7ecdd9024b351f26ccac021f3f10ce2c788bfa8a5d39e2` |
| spec | `artifact-schema/v1:51e41ef9d885736919cae19794256f19dde6112647448ad07cb8c71f7d61c305` |
| plan | `artifact-schema/v1:66a1e9afac28cdb4b4db8fa8e78c9df02da4ddba1952d189279d22025a4ef79e` |
| brief | `artifact-schema/v1:c1303586cb5531a0c0aed8a282c0ad68917d94c94834d336705373166479951f` |
| assessment (both stages) | `artifact-schema/v1:57f201559fcc23f712187d5d695e6b26d79a583199cc4a394df88e6a36116fc9` |

Three upstream limitations remain blocking for the complete contract:

- B1: the engine expression language cannot test absence of the optional
  resolution record with a null/presence literal. The current checks conservatively
  require a resolution to evaluate; an absent resolution cannot be accepted. The
  schema remains optional as specified. The regression is recorded as a todo test.
- B2: request_analysis_changes re-wants the author in revise mode, but approving
  the changed analysis does not invalidate or re-want an already published spec.
  The evaluator replay for the required editor rerun is recorded as a todo test.
- B9: the adapter currently hashes named declarations, rather than their resolved
  schema bodies. Consequently analysis, plan, brief and assessment retain the old
  schema versions despite new shapes. Readers must also use definition_id until
  the adapter's version calculation is corrected in its owning cohort; these
  versions alone cannot distinguish the revised contract.

The cohort changes no compiler, evaluator or adapter implementation. Integration's
request_changes explicitly targets `on: assessment`, as the shipped engine requires
an explicit target when feedback_field is used.

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
