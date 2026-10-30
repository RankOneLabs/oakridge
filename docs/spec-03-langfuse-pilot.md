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

The four `v1` definitions, one per stage, live in `observation/src/grading/catalogue/langfuse-pilot.ts`.
Their pinned recipes live in `observation/src/langfuse/evidence-recipe.ts`.
Each projected reference carries only its role, source ref, digest and deep link;
whole artifact bodies, raw code and specification text remain in the observation
store. An undeclared role or a missing reference address is rejected. An
assessment may have zero linked finding references, which is a meaningful
coverage miss rather than missing evidence.

| Question | Selected item | Pinned input | Pinned output | Answer |
| --- | --- | --- | --- | --- |
| `analysis.finding_relevance/v1` | `analysis.findings` `finding` | Original requested change and relevant excerpt, each by source reference | One analysis finding reference | Choice: relevant, irrelevant or unclear/insufficient evidence |
| `plan.criterion_traceability/v1` | `plan.criteria` `criterion` | Up to 20 tasks and 20 plan decisions the criterion cites, by source reference; at least one in all | One plan criterion reference | Choice: traceable, unsupported or unclear/insufficient evidence |
| `brief.source_fidelity/v1` | `brief.criteria` `criterion` | The identified plan criterion | Its brief criterion with the same criterion id | Choice: faithful, changed meaning or unclear/insufficient evidence |
| `assessment.coverage/v1` | `brief.criteria` `criterion` | One brief criterion | Assessment finding references, possibly empty | Boolean: at least one explicit `assesses` link |

For fidelity, the brief criterion's `derived_from` link uses the unchanged plan
criterion id, which is unique within the run; rewritten text preserves that identity. For coverage, the
catalogue creates an `assesses` link only when the assessment finding has a
string `criterion_id`. A finding with no id has no link and is not itself a
coverage miss. Only a brief criterion with no linked assessment finding is a
miss.

For traceability, the input references are only the criterion's own
`derived_from` links to tasks and to decisions in its cohort; nothing is matched
by text. `planCriterionEligibility` in `observation/src/langfuse/plan-traceability.ts`
classifies a criterion before any grader runs. A criterion with empty `task_ids`
and `decision_ids` is **uncited**, and one citing an id absent from its captured
revision has a **dangling citation**; both are excluded from the population
with a typed reason and never graded. A criterion citing tasks when the run's
tasks revision was not captured is graded with incomplete evidence and abstains.
The population manifest's `reason` is a typed union (`operator`, `uncited`,
`dangling_citation`), and only an excluded member may carry an uncited or
dangling reason. The comparison report lists excluded members per question
pin, split by reason, outside every group denominator. Plan-wide
`plan.acceptance_criteria` items carry no links and are not selected.

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
evaluator. Langfuse Cloud answers `GET /api/public/v2/evaluators/{id}` for a
decision-model evaluator with HTTP 400 ("Decision-model evaluators are not
available through the public API", measured 2026-10-29), so a pinned Jev
evaluator counts as available when an enabled evaluation rule assigns it. Before enabling outbound projection, provision a project and
least-privilege keys, choose a region or self-hosted endpoint, pin the Jev
model and evaluator, run the synthetic write/readback exercise, and record the
returned IDs and timing here. Until then, outbound projection remains pending.

The gate is configuration: `OBSERVATION_LANGFUSE_PHASE_A_TRACE_ID` names the
32-hex trace ID of the passing `--write-synthetic` run. While it is unset,
`LangfuseBackend.project` makes only capability reads and returns the pending
failure. Once set, it POSTs one OTLP span per attempt-scoped mapping to
`/api/public/otel/v1/traces` and returns a `written` outcome carrying the trace
and span IDs. Both IDs are derived from the mapping key's digest, so a replay
re-sends the same target and nothing is stored; the mapping stays `pending`
until a score exists. The span is named `question_id@question_version`, its
input and output are the encoded projection as JSON strings, and trace metadata
is flattened under `langfuse.trace.metadata.*`. Whether Langfuse upserts a
re-sent span with the same IDs is unmeasured and must be recorded from the
first live run. Evidence content reaches the span only for references marked
`kind: "public"`; native evaluators read it from the observation input.
Native evaluator scores are not yet ingested into local grades: `fetch` still
expects a pre-known score ID and Oakridge metadata.

If the native Jev evaluator or evaluator API is unavailable, run the pinned
Jev question through a direct grader in the observation service and store that
result with its own evaluator identity; do not represent it as a Langfuse
score. If queue automation is unavailable, use the existing tenant-bound
human grade intake for manual labels, with its separate provenance. If score
readback is unavailable, leave the external mapping pending and use only local
grades for reports. These fallbacks do not turn integration telemetry into a
correctness judgment.

## Phase A live run (2026-10-29)

`langfuse-capability-spike.ts --write-synthetic` passed against Langfuse Cloud
US (`https://us.cloud.langfuse.com`), project `cmvtt9nhn00fiad0eu6em135c`, on
2026-10-30 00:12 UTC. All four capabilities were available; the
decision-model evaluator was detected through its evaluation rule.

| Item | ID | Readable after |
| --- | --- | --- |
| Trace | `8c0c6e4c78a9ab005f4423931ea02ee5` | — |
| Observation (OTLP v1, read on observations v2) | `1e7bc9c48c73b7c1` | 11.3 s |
| API Boolean score `oakridge.phase_a.synthetic@v1` (scores v3) | `3f6f3cd3-0d19-4de1-a460-6d22860a78fd` | 27.3 s |
| Native Jev score `phase_a.jev_synthetic` (`EVAL`) | `f457db66-cafa-5291-b004-c16bc3c16ad8` | 6.2 s |
| Queue item, completed manually | `cmvu7x31400dead0hqy9r9tof` | 27.5 s |
| Annotation score `phase_a.synthetic_check` (`ANNOTATION`, `true`) | `e5399c9a-2d9d-4a8a-94aa-bb4f99b485ac` | 27.5 s |

`OBSERVATION_LANGFUSE_PHASE_A_TRACE_ID` is set to that trace, which enables
the projection write path. Measured behaviour:

- A native Jev Yes/No score is `NUMERIC` P(true). Its metadata carries
  `typesafe.model` (the evaluator was configured `jev-latest`, which the UI
  offers as the only Jev model; it ran as `jev-1.14.0`), `typesafe.type`
  (`noul`), `typesafe.questionId`, `evaluator_id`, `evaluator_version_id`,
  `evaluation_rule_id`, `job_execution_id`, `target_trace_id` and
  `target_observation_id`. It carries no Oakridge `mapping_key`, and no
  option probabilities beyond the value.
- One `EVAL` score is written per matching rule assignment. With two enabled
  rules assigning the same evaluator, the synthetic observation received two
  scores. The evaluator dialog's default rule is `isRootObservation = true`,
  which matches every pilot observation; pilot rules instead filter
  `name any of ["question_id@question_version"]`.
- An annotation score takes its score config's name and has empty metadata.
  A queue item can be completed without a score: the first run on
  2026-10-29 did so and produced no `ANNOTATION` score.
- Whether a re-sent span with the same IDs is upserted or duplicated remains
  unmeasured.

## Human annotation and held-out boundary

The pilot's human score config names are `analysis.finding_relevance.v1`,
`plan.criterion_traceability.v1` and `brief.source_fidelity.v1`. Langfuse's score-config API permits letters,
numbers, underscores, spaces, periods, parentheses and hyphens in names, so
the config name uses a period before the version. Each category label exactly
matches its `QuestionDefinition.allowed_values`; Langfuse's numeric category
value is only the wire representation. The pure transform also covers
`assessment.coverage/v1`, whose Boolean domain is `false` and `true`.
The queue accepts the four pinned pilot question recipes, which are
categorical or Boolean. The generic score-config transform and parity check
also support a bounded numeric domain, but no numeric pilot evidence recipe
is pinned, so numeric questions cannot be queued in this pilot.
Config descriptions contain the pinned question wording, queue instructions,
the explicit `Graded artifact: report` declaration, abstain rule and unclear
rule. The service validates each config request with the documented API shape
before sending it through the adapter HTTP client.

`POST /v1/langfuse/score-configs` provisions one of the three selected pilot
configs. The operator attaches their returned config IDs to a Langfuse
annotation queue and configures that queue's ID for the service. A request to
`POST /v1/langfuse/annotation-queue/items` names one existing projection
mapping and the pinned evidence references. Before posting an item, the
service requires a single captured source occurrence, one frozen evidence
set with the same digest, one pinned question recipe, and a queue containing
exactly one score config with the matching question name and domain. It reads
the remote observation's IO before handoff and refuses any displayed evidence
content, extra verdict fields, altered question wording or non-pinned source
reference. The queue checks that the displayed score-config instructions
declare report scope exactly; an optional scope marker in observation input
must agree when present. This accepts the existing adapter input shape while
keeping the declaration visible to the reviewer. It then reads the created
item back and stores a queue claim on the Langfuse mapping. The
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
pending. The current adapter projection does not include `graded_artifact` in
remote observation input; scope is instead required in the verified Langfuse
score-config instructions. The counts below are observed pilot counts, not the
synthetic test fixture (which exercises one example of each stratum):

The `oakridge-dbos-tests` CI job supplies PostgreSQL 16 and
`OAKRIDGE_TEST_DATABASE_URL`, and its first shard runs
`bun run --filter observation test`. The DB-gated queue, import and
operator-origin tests run there rather than being skipped.

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

## Phase B Fastino custom upstream probe (2026-10-29)

The intended Langfuse TypeSafe (System One) Custom upstream base URL is
`https://api.fastino.ai/v1`, without `/systemone`. The custom-model catalogue
must use the exact model ID accepted by the selected Fastino API version. The
current [Fastino GLiDE example](https://fastino.ai/blog/introducing-glide-the-first-thinking-decision-model)
uses `fastino/glide` with `Authorization: Bearer` and `Content-Type:
application/json`; another Fastino page shows `fastino/GLiDE`. Neither spelling
has been validated with a credential in this deployment. The
[Langfuse custom connection guide](https://langfuse.com/docs/evaluation/evaluation-methods/decision-models)
says it uses Bearer authorization and supports extra headers.

A live synthetic `POST https://api.fastino.ai/v1/systemone` was attempted with
both `Authorization: Bearer` and `X-API-Key` on 2026-10-29. Each returned HTTP
401 because this worktree has no `FASTINO_API_KEY`; the probe used an invalid
synthetic key. No `OBSERVATION_LANGFUSE_*` configuration is present, so a native
Langfuse custom connection could not be configured or read back. The accepted
model string, working auth method, required headers beyond JSON content type,
and whether Langfuse preserves all probabilities and confidence on readback
remain **unmeasured**. No native observation is claimed. The direct
`POST /v1/systemone` fallback is implemented and exercised against a stubbed
provider boundary in `observation/tests/fastino-glide.test.ts`; a live Fastino
answer also remains unmeasured.

The service model runners store the raw typed answer, every returned option
probability, provider confidence and usage in the local grade and execution
records. Yes/No is a numeric P(true), and a fractional Score keeps its expected
level, legend and distribution. They leave normalization and decision policy
fields null. When a completed grade has an authenticated Langfuse observation
mapping, `POST /v1/langfuse/model-scores` writes a separately labelled raw score
through the Scores API; the local observation remains authoritative. The
adapter's current Phase A projection gate leaves mappings pending until a
deployment completes the synthetic write and readback validation above, so
end-to-end score ingestion has not yet been demonstrated against Langfuse.

When a pinned Choice question includes `insufficient_evidence` and a System One
provider selects it, the local answer is an explicit abstention. The selected
raw provider answer is also retained in execution reproducibility metadata;
low confidence by itself never causes abstention. A Yes/No response that supplies
only `noul` has a derived `false = 1 - noul` probability in the observation;
`probability_provenance` marks the true value as `provider_noul` and the false
value as `derived_complement`. If the provider returns its own probability map,
the map is retained and marked `provider_returned`.

## Phase C pilot report status (2026-10-29)

The live Phase B pilot could not run in this worktree. The environment supplied
no `OBSERVATION_DATABASE_URL`, observation service read/grade credentials,
`OBSERVATION_LANGFUSE_*` deployment settings, or Fastino key; no observation
service answered at `127.0.0.1:8791`. The adapter's `LangfuseBackend.project`
also still returns the Phase A validation gate rather than creating a remote
target. The checked-in runner and report scripts are therefore ready for an
operator-supplied selection and deployment, but **no real item-level cases were
selected or frozen, no dual export was performed, and no live grader or human
label series was collected in this cohort**. The actual live sample count is
0. Agreement, missing coverage, per-label disagreement, cost and latency for
the live pilot are **not measured**; no threshold was fitted or reported as
held-out validation. There are no live ambiguous cases to classify. This is a
rollout boundary, and a numerical go decision would invent evidence.

The local code and database drills did produce three concrete observations:

1. The comparison fixture contains one answered, one missing and one failed
   attempt against a frozen item/evidence pair. The report denominator is 3;
   it records the missing and failed states separately. This is a fixture
   assertion, not pilot coverage.
2. A scratch-database grade remained readable while a stubbed Langfuse score
   endpoint returned HTTP 503. Replaying the mapping after recovery left one
   target mapping and one unchanged local grade, and a second reconcile made no
   remote read. This is an observed local replay drill, not a live outage.
3. With the adapter disabled, a scratch service accepted an external grade,
   returned the raw grade, and froze an Assay export containing the occurrence.
   Existing offline tests also exercised producer ingest and lineage reads.

What Langfuse could not do in this environment is explicit: it could not be
probed against a provisioned project, receive the selected revisioned
occurrences, run or read back native Jev/Fastino evaluator scores, host a
completed blinded annotation series, or demonstrate score retrieval after a
real outage. Its score analytics could not produce measured agreement or
coverage for this population. Independently of deployment availability, the
native trace/score model does not itself encode Oakridge revision and lineage
pins or a frozen Assay study; the adapter and manifest provide those links.
The current adapter cannot write a real target until its Phase A gate is
removed after validation. These are observed availability and implementation
limits, not a claim that the Langfuse product lacks those features.

The **assessment is no-go for rollout now**. Native Langfuse trace, score and
annotation surfaces could save work on exploratory review if the selected
deployment proves their ingestion and readback behavior. Item-level revision
lineage remains awkward because it must be carried as pinned metadata and
cross-checked against Oakridge rather than inferred from a chart. Operations
would own project credentials, evaluator and queue configuration, retry/replay
monitoring, redaction policy and the separate Assay freeze. The neutral adapter
is viable in local contract and outage drills: Oakridge ingest, grades, reads
and export did not depend on Langfuse. Viability against a real deployment,
including native evaluator behavior and the full 10–30 case comparison,
remains unmeasured. No grader superiority claim follows from these fixtures.
