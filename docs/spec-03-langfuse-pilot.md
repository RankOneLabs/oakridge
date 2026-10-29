# Spec 03 Langfuse pilot: contract decisions

These decisions pin the pilot contract so the storage, adapter and grading
cohorts can be reviewed against one shape. The HTTP transport is fixed for this
cohort; the other rollout choices still require an operator decision.

| Open decision | Planner recommendation pending operator confirmation | Rationale |
| --- | --- | --- |
| Transport (section 2) | **Selected:** HTTP through the platform `fetch` API. | The observation package has an exact dependency allowlist (`hono`, `kysely`, `pg`, `zod`). HTTP keeps the adapter behind the port without adding an SDK or expanding that list. |
| Privacy classification (section 4.1) | Use a separate Langfuse projection policy declaring sensitivity for analysis, plan, brief and assessment bodies. Classify other artifact kinds as restricted. | The Assay export policy describes an offline dataset and does not yet declare sensitivity kinds for these bodies. A separate policy makes the external disclosure choice explicit. The projection encoder includes public evidence content, withholds unclassified references, and gates raw build output, raw test output and repository content on explicit policy flags. |
| Observation granularity (section 4.2) | Create one observation per selected occurrence/question package. | Each question has its own wording, version, input recipe and score name. Including question identity in the mapping key prevents two questions sharing an evidence set from colliding. |
| Existing Oakridge human labels (section 6) | Report `authority.review_decision` and `authority.collaboration_thread` labels as a separate comparison series, apart from blinded annotation labels. | Existing operator feedback is valuable context, but its collection path and visibility differ from a held-out annotation sample. A separate series preserves both without implying that the historical labels were blinded. |
| Sync state location (section 7) | Keep `queued`, `pending`, `timed_out`, `unmatched` and `stale` on a distinct Langfuse mapping/sync record; retain `completed` and `failed` there as sync outcomes. | The local `evaluation_execution.status` remains `running`, `completed` or `failed`. An unmatched inbound score may have no local execution row, so putting that state on an execution would misrepresent the source of truth. |

## Contract pinned by this cohort

`EvaluationBackend.project` accepts a named input containing the local execution,
captured evidence package, question definition and pinned question text, source
revision context, projection policy and projection version. It returns the
external trace, observation, score and annotation queue item IDs as a `Result`.
`fetch` reads inbound scores and annotation outcomes for an authenticated mapping;
`reconcile` repairs a known mapping when an API response was missed or a later
read resolves eventual consistency. Each failure carries operation, entity ID
and detail. With no adapter configured, local capture, grading and reads continue;
the no-Langfuse backend reports external calls as disabled domain errors.

The trace metadata contains producer, namespace, run and unit IDs, artifact kind,
revision ID and digest, optional logical item ID, occurrence ID, extractor
version, question ID and version, and privacy classification. The observation
input carries question wording, its input recipe and policy-scoped evidence;
the output carries the local execution state and outcome metadata. The score
name is `question_id@question_version`.

The evidence-set digest is the `canonical-json/v1` digest of
`{evidence_refs, is_incomplete, incompleteness_reason}`, matching the
[Assay export contract](observation-assay-export.md). `evidence_set_id` does not
substitute for that digest. The mapping key is the `canonical-json/v1` digest of
the ordered tuple `(occurrence_id, evidence_set_digest, question_id,
question_version, projection_version)`. Repeating the same projection is
idempotent; changing evidence content or the selected question creates a new
target identity.

`projection_version` describes only the Langfuse trace/observation projection
shape: field placement, evidence encoding and score naming. It is independent
of `extractor_version`, already pinned in `occurrence_id`, and of
`question_version`. Bump it only when a changed projection shape would make new
observations structurally incomparable with old ones. A bump creates new mapping
keys and targets. Existing mappings remain readable and are never rewritten to
the new shape.

## Pilot catalogue and evidence boundary

The three `v1` definitions live in `observation/src/grading/catalogue/langfuse-pilot.ts`.
Their pinned recipes live in `observation/src/langfuse/evidence-recipe.ts`.
Each projected reference carries only its role, source ref, digest and deep link;
whole artifact bodies, raw code and specification text remain in the observation
store. An undeclared role or a missing reference address is rejected. An
assessment may have zero linked finding references, which is a meaningful
coverage miss rather than missing evidence.

| Question | Selected item | Pinned input | Pinned output | Answer |
| --- | --- | --- | --- | --- |
| `analysis.finding_relevance/v1` | `analysis.findings` `finding` | Original requested change and relevant excerpt, each by source reference | One analysis finding reference | Choice: relevant, irrelevant or unclear/insufficient evidence |
| `brief.source_fidelity/v1` | `brief.criteria` `criterion` | The identified plan criterion | Its brief criterion with the same cohort criterion id | Choice: faithful, changed meaning or unclear/insufficient evidence |
| `assessment.coverage/v1` | `brief.criteria` `criterion` | One brief criterion | Assessment finding references, possibly empty | Boolean: at least one explicit `assesses` link |

For fidelity, the brief criterion's `derived_from` link uses the unchanged plan
cohort criterion id; rewritten text preserves that identity. For coverage, the
catalogue creates an `assesses` link only when the assessment finding has a
string `criterion_id`. A finding with no id has no link and is not itself a
coverage miss. Only a brief criterion with no linked assessment finding is a
miss.

`observation/src/langfuse/classification.ts` declares the top-level body field
kinds for analysis, plan, brief and assessment. A field absent from its artifact
map is `unclassified_content` and is withheld; only fields declared `public`
pass through a whole-body projection. This policy is separate from the frozen
Assay export redaction policy. An explicit recipe can name bounded source
references for grading while leaving source content in the observation store.

The service coverage checker reads the selected brief criterion and the
catalogue's assessment finding links as a small local link view. It answers
`false` when no `assesses` link points to the criterion, including when the
assessment has no findings. Unlinked integration findings do not add misses.
The Jev Score encoder retains a fractional expected rubric level, the full
level distribution and probabilities in a structured answer. The stored
`normalized_score` and decision policy fields remain null until a separately
versioned decision policy is applied.

## Phase A deployment probe status (2026-10-28)

The checked-in `observation/scripts/langfuse-capability-spike.ts` was run in the
cohort worktree with `env -u BUN_INSPECT bun observation/scripts/langfuse-capability-spike.ts`.
It exited 2 with the disabled result because no `OBSERVATION_LANGFUSE_*`
configuration was supplied. No Langfuse deployment or project credential was
available in this environment, and no local deployment answered at
`127.0.0.1:3000`. **Cloud versus self-hosted has not been selected.** The
deployed version's OpenAPI, project scope, native Jev connection and model
string, queue identifier, feature/license prerequisites, synthetic trace,
score and annotation IDs, ingestion delay and retrieval path therefore remain
unmeasured. There is no claim of a successful live Phase A run.

The reference contract consulted during implementation is the
[Langfuse public API and OpenAPI location](https://langfuse.com/docs/api-and-data-platform/features/public-api),
not a deployed instance. Its current route versions are observations v2,
scores v3, evaluators/evaluation rules v2, and annotation queues under
`/api/public/annotation-queues`. The [OTLP trace endpoint](https://langfuse.com/docs/observability/get-started)
uses `/api/public/otel/v1/traces` with `x-langfuse-ingestion-version: 4`.
These are reference versions, not measured deployment versions. The
[score contract](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk)
allows an optional score ID, while the queue-item API returns its own ID.
The current port requires all four IDs up front; a native evaluator score
does not exist until the evaluator runs. The adapter keeps a mapping pending
instead of inventing that score or its ID.

The probe checks the deployment's own OpenAPI plus authenticated evaluator,
queue, score and rule routes. Its default mode is read-only; the explicit
`--write-synthetic` mode creates a synthetic OTLP observation, deterministic
Boolean score and queue item, then polls readback and manual queue completion.
It returns a typed unavailable capability, naming the route or missing pinned
evaluator. Before enabling outbound projection, provision a project and
least-privilege keys, choose a region or self-hosted endpoint, pin the Jev
model and evaluator, run the synthetic write/readback exercise, and record the
returned IDs and timing here. Until then, outbound projection remains pending.

If the native Jev evaluator or evaluator API is unavailable, run the pinned
Jev question through a direct grader in the observation service and store that
result with its own evaluator identity; do not represent it as a Langfuse
score. If queue automation is unavailable, use the existing tenant-bound
human grade intake for manual labels, with its separate provenance. If score
readback is unavailable, leave the external mapping pending and use only local
grades for reports. These fallbacks do not turn integration telemetry into a
correctness judgment.

## Human annotation and held-out boundary

The pilot's human score config names are `analysis.finding_relevance.v1` and
`brief.source_fidelity.v1`. Langfuse's score-config API permits letters,
numbers, underscores, spaces, periods, parentheses and hyphens in names, so
the config name uses a period before the version. Each category label exactly
matches its `QuestionDefinition.allowed_values`; Langfuse's numeric category
value is only the wire representation. The pure transform also covers
`assessment.coverage/v1`, whose Boolean domain is `false` and `true`.
Config descriptions contain the pinned question wording, queue instructions,
abstain rule and unclear rule. The service validates each config request with
the documented API shape before sending it through the adapter HTTP client.

`POST /v1/langfuse/score-configs` provisions one of the two selected pilot
configs. The operator attaches their returned config IDs to a Langfuse
annotation queue and configures that queue's ID for the service. A request to
`POST /v1/langfuse/annotation-queue/items` names one existing projection
mapping and the pinned evidence references. Before posting an item, the
service requires a single captured source occurrence, one frozen evidence
set with the same digest, one pinned question recipe, and a queue containing
exactly one score config with the matching question name and domain. It reads
the remote observation's IO before handoff and refuses any displayed evidence
content, extra verdict fields, altered question wording or non-pinned source
reference. The remote input must also declare whether the report or code is
graded. It then reads the created item back and stores a queue claim on the Langfuse mapping. The
claim is required by `POST /v1/langfuse/annotations/import`, so an unrelated
queue item cannot be declared a blinded label by supplying its ID.

Import reads the completed queue item, the annotation score with its subject
and author fields, and the score config. It authenticates their project,
trace, observation, queue, question and category domain against the pinned
mapping. `POST /v1/grades` and the import route share `acceptHumanGrade`;
the imported score uses the human evaluator and the normal answer union.
The mapping preserves the Langfuse score and queue-item IDs, and reviewer
details retain the author, score timestamp and creation or revision action.
Reviewer notes are retained only when `allow_notes` is explicitly true.
The generic grade route refuses the reserved evaluator IDs used by the
Langfuse importer and Oakridge operator backfill, so a direct grade request
cannot claim either observation origin.
Each changed score timestamp creates a new attempt label and an immutable
grade whose `supersedes_observation_id` points to the previous annotation.

The generated `grade_observation.label_origin` field recognizes the existing
`oakridge-review:<review>:<item_kind>` version `1` rows written by
`backfill-store.ts` with evaluator `oakridge-operator-human` and reviewer
`oakridge-operator` as `oakridge_operator_unblinded`. It classifies imported
Langfuse human grades as `langfuse_annotation_blinded`; other grades are
`other`. This derivation applies to historical rows during migration without
rewriting their append-only answers. The grades read contract exposes the
origin, and `GET /v1/langfuse/label-series` reports separate counts for held-out
Langfuse annotations, Oakridge operator verdicts and collaboration threads.
Only the positive blinded-origin series is eligible for held-out comparison.
Existing operator verdicts and collaboration comments never enter the
sampling inputs. The original assessor verdict is recorded separately and
is absent from the reference-only package handed to a blinded judge or
annotator; each package declares whether the report or code is graded.

The actual deployed annotation sample at this revision is **empty**. No
Langfuse project credentials or captured pilot occurrences were supplied to
this cohort, and the adapter's Phase A gate still leaves projection mappings
pending. The current adapter projection does not yet include the required
`graded_artifact` field in remote observation input, so the queue guard will
also refuse its observations until that producer contract is updated. The
counts below are observed pilot counts, not the synthetic test
fixture (which exercises one example of each stratum):

| Stratum or required case | Selected | Labelled |
| --- | ---: | ---: |
| Clearly easy | 0 | 0 |
| Borderline | 0 | 0 |
| Known failure | 0 | 0 |
| Split criterion | 0 | 0 |
| False verified claim | 0 | 0 |

The pilot requires at least one split criterion and one false verified claim
before any agreement result is reported. Once pinned source examples exist,
the sample selector takes independently assigned strata and source IDs, never
operator verdicts. Held-out reporting must show raw confusion counts,
agreement, coverage, abstentions, confidence bands and disagreements; a
threshold tuned on an example cannot be reported as held-out validation on
that same example. Historical Oakridge labels may be compared in their own
unblinded series, with their different collection and visibility stated.
