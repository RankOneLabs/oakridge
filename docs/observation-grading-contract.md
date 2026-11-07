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
table, column, key, CHECK predicate, trigger, function and index that the schema test compares against a fresh
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

## Grader configuration

`observation/graders.json` is the only grader selection. Code, prompts and fixtures select none, and
there is no fallback. It lists questions by `question_id`, each with one or more graders:

```json
{ "questions": [{ "question_id": "finding.relevance", "graders": [{ "runner": "jev_direct",
  "model": "jev-1.14.0", "estimated_cost_per_call": 0.01, "instructions": { "system_one": { "...": "..." } } }] }] }
```

`observation/src/grading/configuration.ts` parses it strictly: an unknown or missing field is refused.
`runner` must be a key of the retained registry in `observation/src/grading/runner.ts`, which holds
exactly `jev_direct`, `fastino_glide` and `llm_judge`. `instructions` are the runner's own format, a
System One recipe whose choice criteria name exactly the question's answers, or a judge rubric with
`max_evidence_chars`, and are checked against the question before anything is registered.
`estimated_cost_per_call` is carried on the definition for the later per-run budget; nothing here
admits or limits spend.

At startup the service:

1. reads `graders.json` and maps it onto the producer's questions; a configured question the producer
   does not ask, a repeated question or grader, an unknown runner or unusable instructions stops it;
2. requires every selected runner's required settings in its own environment, which the launcher
   fills from `observation/.env` only; a missing key stops it, naming the setting and never a value;
3. registers, for every tenant its credentials reach, the producer's questions, one immutable
   evaluator definition per configured grader and one human evaluator, then reports the configured
   graders in `/health`.

A configured definition's id is the canonical digest of its identity. The identity covers the
question version, runner, model, instruction text and estimated cost, so any edit is a new
definition. Registration is idempotent and never alters or removes a definition, so a restart under
an edited `graders.json` adds the new definitions beside every earlier one. The human evaluator names
no reviewer: a human answer takes its reviewer from the grade credential that submits it. Provider
keys stay in `observation/.env` and the observation process; they never reach `graders.json`, kbbl,
the browser or a report.

Every question is pinned with its configured graders and the human evaluator. A question
`graders.json` does not mention is pinned to the human evaluator alone.

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

The pins a capture writes come from the registration made at startup, so a `graders.json` edit takes
effect at the next restart and reaches only occurrences captured after it. An occurrence captured
earlier, ready or not, keeps the question version and evaluator set it was captured with; when its
evidence arrives later it becomes ready under those pins. No restart, edit or late input creates an
execution, calls a provider or regrades an item. There is no eligibility, assignment, visibility or
job record: the `evidence_set` row is the pin.

Collection runs after each accepted source event, for the waiting questions of that event's run, and
once at startup for every run with a waiting question. Each question is collected and recorded on its
own, and the acknowledgement does not wait for it. Collection consults no automatic-grading setting,
task, approval or human action, so it behaves the same whether automatic grading is on or off.
`GET /v1/items/:id/evidence` serves each pinned question of an item with its version, evaluator set
and readiness.

## Evidence references

A reference records where its content came from, without digests or classification:

- `revision`: content from an exact `revision_id`, and `item_path` when it is one item.
- `run_input`: a field of the run's captured launch input.
- `repository`: a file at an exact `commit_sha`, with its path and line range. `is_absent` records a
  file missing from a readable commit, which is evidence rather than a failed read.
- `reported`: text the producer's agent reported, passed through and never independently verified.
  It keeps the exact `revision_id` and `item_path` it was reported at.

A provider is shown each reference under its label with its source, every provenance field and its
content (`providerEvidence` in `observation/src/grading/evidence.ts`): System One runners as one
`state` entry per label, the judge as one list entry per label. A file missing at its commit arrives
as `is_absent: true` with `content: null`, and a range as its `line_range`. The committed
`graders.json` instructions describe that shape: the finding is `state.subject`, and
`reported` entries are the agent's own report. `observation/tests/provider-input.test.ts` captures
the request each retained runner sends through an injected transport.

Repository files are read with `git cat-file` at the exact commit, never from a worktree
(`observation/src/storage/git-repository-reader.ts`). A path missing from a readable commit is
`absent`. A repository or commit that cannot be read makes the question that needed it wait with
`repository_unavailable`.

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
| `finding` | Relevance | The finding (`subject`) and the full captured launch spec (`spec`) | `relevant`, `irrelevant`, `unclear` |
| `assessment_finding` | Correctness | The finding, its citations, the assessment's reported test results, the exact `subject_id` build when set, and available linked task context | `supported`, `contradicted`, `unclear` |
| `assessment_finding` | Evidence support | The finding, its citations and the assessment's reported test results | `supports`, `does_not_support`, `unclear` |

Evidence references are labelled `subject`, `spec`, `build_result`, `citation:N`, `test_evidence`
and `task_context:N`. `test_evidence` is the assessment's own `test_evidence` (passed, failed,
output, summary and `cargo_test_output`), passed whole as `reported` at the assessment revision and
`/test_evidence`; an assessment without it has no such reference and does not wait. The repository for file citations is the launch repository that holds the
assessment's `head_sha`, whichever it is; each citation keeps its path and line range. An
unparseable reference, and every `test` and `output` citation with its reported detail, is passed as
`reported` text at `<finding path>/evidence/<index>`. Correctness waits with `build_result_unavailable` until the exact `subject_id`
revision is captured; Evidence support on the same finding does not wait for it. Task context is the
same run's linked task definition and plan or brief acceptance entries, each at its own revision and
path, and is included only when an explicit link resolves.

| Not-ready code | Question | Retried when |
| --- | --- | --- |
| `collection_pending` | any | Collection has not run yet. |
| `spec_unavailable` | Relevance | The run's launch input with its spec is captured. |
| `revision_unavailable` | Correctness, Evidence support | The finding's revision is readable. |
| `commit_unavailable` | Correctness, Evidence support | Only for file citations: the assessment names a `head_sha`. |
| `repository_unavailable` | Correctness, Evidence support | Only for file citations: a launch repository holds that commit. |
| `build_result_unavailable` | Correctness | The `subject_id` build result is captured. |

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

- `GET /v1/items/:id/evidence`

Every read carries its credential's tenant. No route dispatches a provider or writes an answer yet.

## Verification

Offline, from the repository root, with `OAKRIDGE_TEST_DATABASE_URL` naming a local PostgreSQL:
`bun run --filter observation test` and `bun run typecheck`. No storage record changed, and
`bun run --filter observation storage:check` passes against the existing baseline.

- `observation/tests/grader-configuration.test.ts`: the committed `graders.json` configures every
  question; registration selects exactly the configured graders plus one human evaluator; several
  graders per question; deterministic ids and a new id for each model, instruction or cost edit;
  unknown runner, question, instructions, duplicates and misspelt fields refused; a missing key
  refused by name; and no source, fixture or prompt naming a runner outside the registry or a
  configured model.
- `observation/tests/grading-startup.test.ts`, through the real service and HTTP: startup
  registration and an idempotent restart; refusal of an unknown runner, unreadable file or missing
  key before anything is registered; a not-ready capture (repository unreadable, build subject
  absent) with Evidence support ready while Correctness waits, a `graders.json` swap and restart,
  readiness arriving under the original pins, a later capture taking the swapped pins, a late link
  leaving identity and frozen evidence unchanged, both configurations' definitions retained and no
  execution, provider attempt or answer; and a restart retrying questions left waiting.
- `observation/tests/git-repository-reader.test.ts`: real git repositories, reading at the commit
  rather than the worktree, absent paths, unreadable commits and repositories, and a
  `core/decision-record.ts:18-31` range read from a non-primary launch repository.
- `observation/tests/producer-evidence.test.ts` and `capture-pins.test.ts`: the three question
  contracts, spec, subject and repository provenance, unparseable, empty and agent-reported
  citations, integration without a subject, task context and frozen shared evidence.

On the shadow, through `observation/verification/proof.ts`:

- `live` passed (`observation/verification/reports/live-2026-11-07T16-59-47-486Z`): the service
  started from `graders.json` and reported its three configured graders.
- `registration` without `--input` (`observation/verification/reports/registration-2026-11-07T17-00-48-602Z`)
  recorded both startups' registrations, three new definitions after the edit with every earlier one
  kept, and no execution or provider request. Its capture checks fail: no real development run was
  captured, because a run's `prepare` step creates its base branch on the input's forge. The
  capture, pin-retention and later-capture checks run only with `--input`.
