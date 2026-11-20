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
assignment to its cohort and only its allocated canonical requirements. The engine
computes the plan's `order` from depends_on when the plan is accepted:
`levels(cohorts, id, depends_on)` groups cohorts by dependency depth, so cohorts
with no path between them share a level. The briefs collection follows that
order in one shared writer session. A brief starts once every brief in an
earlier level has been published, its writer turn has ended and it has no open
blocker, without waiting for approval, so each brief builds on the contracts its
upstream briefs wrote. A failed or blocked upstream writer holds its dependents. Briefs
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
`e750f73b157cff44b9696ed7f10603a085145e7b79123dbf976262fdfa36c9e3`.
The previous definitions
`87dac99799b3d699b92499d4d322929a8b6a107c2cbdf7ab09bfb03874aa736b`,
`cf39117805e56b4bdc5540fed9c4a3c2202a9c432b8e7562bf76960fe383a9a5` and
`74de304c8c29fc50ac3596817a2aed2ffb14846ccb8ecb7ef59f91127b7f87f4`
and their exact prompt objects remain addressable.

Current `artifact_schema_version` values, calculated by the observation adapter
from the resolved schema bodies in the pinned requirement contract:

| Artifact | Schema version |
| --- | --- |
| blocker | `artifact-schema/v2:fd7d3d5480c6a7821d205607dc4277d6078ba93c8b3892de4ce4f1877acb96e4` |
| analysis | `artifact-schema/v2:ae5a9fb9c1a0cf37fbf047000c36f234da2d338552efe6f97f8a9a59890cdbde` |
| spec | `artifact-schema/v2:3e6831d5b78d1a4ac06096edd5901aae62889530f407b8581a71698e4e65ca58` |
| plan | `artifact-schema/v2:532d3d3e11f8df58a07618e8093374bb8e3e4f2348fa49a980bbbecb8290174d` |
| brief | `artifact-schema/v2:e04f77b836567abab8dc575972e28ad6c16c4fed569e0bbb3cb6653783913969` |
| assessment (both stages) | `artifact-schema/v2:8128a3b8a1dbedf479cfe122a42e3538d84106a436cb5de25a8716def76f747b` |

The spec-based requirement contract uses the v2 epoch, including for implicit
blockers whose schema body is unchanged. Historical tasks-based contracts retain
the exact v1 declaration fingerprints on replay. Nested named schemas are resolved
before hashing v2 bodies; prompt edits and unrelated schemas do not move versions.

Run `bun oakridge-dbos/scripts/generate-artifact-versions.ts` after building the core
WASM to regenerate the backend and observation manifests, then regenerate the PWA
operator contracts. `--check` verifies both manifests without writing them.

Two upstream limitations remain blocking for the complete contract:

- B1: the engine expression language cannot test absence of the optional
  resolution record with a null/presence literal. The current checks conservatively
  require a resolution to evaluate; an absent resolution cannot be accepted. The
  schema remains optional as specified. The regression is recorded as a todo test.
- B2: request_analysis_changes re-wants the author in revise mode, but approving
  the changed analysis does not invalidate or re-want an already published spec.
  The evaluator replay for the required editor rerun is recorded as a todo test.

The workflow-contract cohort changes no compiler or evaluator implementation.
Resolved observation fingerprinting is supplied by the observation-requirements cohort. Integration's
request_changes explicitly targets `on: assessment`, as the shipped engine requires
an explicit target when feedback_field is used.

## Definition store

The generator also writes the committed definition store under `definitions/`:

- `workflows/<definition_id>.json` carries the authored source, one
  `operation_registry_id`, two prompt-path-to-PromptId maps, and ordered
  `schema_names` and `stage_names` arrays. `prompts` maps each referenced path
  to its text with every include expanded, which is what a session receives;
  `prompt_sources` maps every authored file the expansion read, included files
  among them, to its authored text, which is what an operator edits.
- `prompts/<prompt_id>.md` holds both authored and expanded texts, byte for byte,
  including line endings.
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

A prompt includes another with `{{> path}}`, the included file's path under
`prompts/`, as `{{> shared/raise-blocker.md}}`. The included text replaces the
directive, less one trailing newline, so a directive on its own line reads as the
included paragraph. Includes nest; a missing file or a prompt that includes
itself fails generation. Expansion happens when a definition is committed, so the
compiler checks each expanded prompt's `{{ input }}` names against the worker or
review that uses it, and an edit to an included file changes the ID of every
definition that reads it. Shared text lives in `prompts/shared/` and, for one
workflow, `prompts/<workflow>/shared/`.

Authored order is captured from YAML mapping nodes before conversion to JavaScript
objects, whose enumeration would sort integer-like names such as `"2"` and `"1"`.
This order is retained through canonicalization: reordering
`schemas:` or `stages:` changes the corresponding ordered array and therefore the
definition ID. This preserves the author's schema and stage list order for later
consumers. Other mappings, including a stage's `workers:` and an `input:` record's
fields, have no order array: reordering their keys preserves identity. Changing
any pinned prompt bytes, included files among them, or operation registry content
changes the definition ID.

`src/definition-store.ts` resolves a definition ID, or an authoring label through
the launchable catalog, into `ResolvedDefinition`. At the file boundary it checks
UTF-8, raw byte hashes, canonical JSON, object shapes, ordered name membership,
all transitive prompt and registry references, and that each committed prompt is
the expansion of its committed sources. It returns `hash_mismatch`,
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
`r5-cohort.json` fixture has no committed definition. The workflow tests exercise
the Rust evaluator through WASM as well as the identity and store boundaries.
Build that prerequisite before running them (CI performs the same build):

```bash
cargo build --manifest-path workflow-core/Cargo.toml --locked --target wasm32-unknown-unknown -p workflow-evaluator
bun test workflow-config/src
```

`bun run typecheck` includes this package.
