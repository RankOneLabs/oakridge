# Observation grading contract

Observation measures one narrow item in one immutable artifact revision. Grading follows
**artifact revision → item → question and evidence → grader answer**. Task tracking follows
**task → explicit item links → existing answers**. Each path works without the other: an item is
gradeable with no task, link or approval, and a link added later changes the tracking view only.

The service is domain-neutral. A producer profile (`observation/src/ports/producer-profile.ts`) is
the only way producer knowledge enters it, and it is injected at the composition root. Generic
storage, grading and projection code never imports a profile implementation, and core code and
tables name none of a producer's concepts. The Oakridge profile lives in
`observation/src/producers/oakridge/`.

## Model

The empty-database baseline `observation/src/storage/migrations/0001_observation.sql` holds exactly
fifteen tables. `observation/tests/target-schema.ts` is the independently written inventory of every
table, column, key, trigger, function and index that the schema test compares against a fresh
database.

| Type | Table | What it is |
| --- | --- | --- |
| `SourceRevision` | `source_revision` | An immutable copy of one producer artifact revision. |
| `ItemOccurrence` | `item_occurrence` | One selected item, addressed by revision and path. The thing graded. |
| `LogicalItem` | `logical_item` | One thing tracked across revisions, scoped to a run. Optional. |
| `ItemRelation` | `item_relation` | A directed edge the producer stated. An unresolved target stays visible. |
| `ExtractionIssue` | `extraction_issue` | A failed selection. |
| `QuestionDefinition` | `question_definition` | Versioned wording, its `item_kind` and its answers. |
| `EvaluatorDefinition` | `evaluator_definition` | One grader: human, or a runner with a model and instructions. |
| `EvidenceSet` | `evidence_set` | One occurrence and question: the capture pin, readiness and frozen evidence. |
| `EvaluationExecution` | `evaluation_execution` | One measurement, and the only queue, lease and retry record. |
| `ProviderAttempt` | `grading_provider_attempt` | One real provider request for an execution. |
| `GradeObservation` | `grade_observation` | One append-only answer, read through its execution. |

`schema_baseline`, `extractor_definition`, `source_event_cursor` and `source_event_outcome` complete
the fifteen.

## Pins and readiness

`evidence_set` has one row per occurrence and question version, written in the capture transaction.
The row *is* the pin: it names the question version and, in `pinned_evaluator_definition_ids`, the
full evaluator set applicable when the occurrence was captured. Pins exist whether or not evidence is
available and whether or not automatic grading is on, and they create no execution.

A capture pins only a newly stored occurrence, so a replay under a later configuration does not
repin it. Later configuration reaches later captures. Question and evaluator definitions are
append-only, so a pinned definition stays readable across restarts; a change is a new definition,
never an edit.

`readiness` starts as `not_ready` with the reason `collection_pending`. Each question moves on its
own: collection records either a retryable `not_ready_code` and `not_ready_detail`, or `ready` with
its references. Ready evidence is frozen by trigger and shared by every evaluator. A later link never
changes it.

`ArtifactSource.collect` takes the occurrence and question and returns ready references or a
not-ready reason. A failed required lookup delays only the question that needs it.

## Evidence references

A reference records where its content came from, without digests or classification:

- `revision`: content from an exact `revision_id`, and `item_path` when it is one item.
- `run_input`: a field of the run's captured launch input.
- `repository`: a file at an exact `commit_sha`, with its path and line range. `is_absent` records a
  file missing from a readable commit, which is evidence rather than a failed read.
- `reported`: text the producer's agent reported, passed through and never independently verified.

## Measurements

`evaluation_execution` owns subject, evidence, question and evaluator identity. A database trigger
requires ready evidence and a pinned evaluator, and foreign keys keep the evidence on the same
occurrence and question and the occurrence in the same run. Lifecycle fields move through `queued`,
`claimed`, `reclaimable` and `budget_deferred` until the execution ends as `completed` or `failed`.
An ended execution, and any execution's identity, is immutable.

`grading_provider_attempt` records real requests by `execution_id`, apart from the measurement.

## Answers and corrections

`grade_observation` is append-only with no exception. An answer needs a completed execution of the
question's response kind, and one execution holds one answer. `{state:"answered",kind,value}` carries
a value; `{state:"abstain"|"unclear",kind,reason}` does not stand for a negative answer. `unclear` as
a choice is an actual answer.

A reviewer is named exactly when the evaluator is human. A human submission is one completed execution
whose `attempt_label` carries the submission id and whose `idempotency_digest` is derived from the
reviewer and submission id alone, so a resubmission lands on the same row.

A correction is a new submission whose observation sets `supersedes_observation_id`. A trigger
requires it to measure the same occurrence, question, evidence and evaluator for the same reviewer,
through both executions. The one-successor key keeps each history linear, and the earlier answer and
its evidence stay unchanged. Machine answers are not corrected.

## Oakridge profile

- **Items:** `finding` from each analysis finding and `assessment_finding` from each implementation or
  integration assessment finding, both addressed by revision and path. Item identity holds no task id.
- **Tasks:** one run-scoped logical item per `task_id`, from the `tasks` artifact. Plan and brief
  `acceptance_criteria` entries are occurrences of that logical item; their `id` is the task id. A task
  shared by cohorts stays one logical item, and the same id in another run is another item.
- **Links:** each id in an assessment finding's `task_ids` is one `assesses` edge to the logical task.
  An empty list is valid. An unknown id stays unresolved and resolves in place if the task arrives.
  Links are never inferred from requirement ids, feedback, text, timestamps or unit paths.
- **Late links:** `declareRelationInTransaction` adds an explicit edge to an item addressed by source
  revision and path, without touching the item, its pins, evidence or answers.
- **Composites:** the profile's path follows a task's incoming `assesses` edges to occurrences and on to
  their answers. A composite is a read and creates no record.

| Item kind | Question | Evidence | Answers |
| --- | --- | --- | --- |
| `finding` | Relevance | The finding and the full captured launch spec | `relevant`, `irrelevant`, `unclear` |
| `assessment_finding` | Correctness | The finding, its citations, the exact `subject_id` build when set, and available linked task context | `supported`, `contradicted`, `unclear` |
| `assessment_finding` | Evidence support | The finding and its citations | `supports`, `does_not_support`, `unclear` |

Risks and decisions are captured but not graded. Tasks, whole artifacts and verdicts have no direct
grade. A missing task, link or approval never makes a question wait; neither does an integration
assessment's absent build subject or an empty citation list.

## Approvals

Approvals stay in Oakridge. `operator_decided` maps to `ignored` for accept and request-changes alike:
it advances the source cursor and creates no evidence, execution or answer.

## HTTP routes

The ingest credential uses `GET /v1/sources/oakridge/cursor` and `POST /v1/sources/oakridge/events`.
The read credential uses:

- `GET /v1/sources/oakridge/unmapped`, `GET /v1/source-revisions/:id`
- `GET /v1/runs/:run_id/items`, `GET /v1/items/:id`, `GET /v1/items/:id/lineage`, `GET /v1/items/:id/grades`
- `GET /v1/questions/:id/versions/:version`, `GET /v1/evidence-sets/:id`
- `GET /v1/evaluations/by-digest/:digest`, `GET /v1/evaluation-executions/:id` (also the grade credential)

Every read carries its credential's tenant. No route dispatches a provider or writes an answer yet.
