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
`GET /v1/items/:id/evidence` serves each pinned question of an item with its version, evaluator set,
readiness and frozen references, each list paged.

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

### Human submission

`POST /v1/items/:id/answers`, with the grade credential, takes `question_id`, `question_version`,
`submission_id`, `answer`, optional `rationale` and, for a correction, `corrects_observation_id`
(`HumanSubmissionRequest` in `observation/src/http/grades.ts`). Parsing is strict: a field naming a
reviewer, evaluator or evidence set is refused. The reviewer comes from the credential, and the human
evaluator and frozen evidence are resolved from the question's pin, so a human answer shares the
evidence set machine answers use.

| Response | Meaning |
| --- | --- |
| `201` `recorded` | The answer was appended. This acknowledgment is what a client may call saved. |
| `200` `duplicate` | This reviewer already used this submission id. Nothing changed; the original result returns, whatever the repeat carried. |
| `404` `item_not_found`, `question_not_pinned` | Outside this tenant, or a question not pinned to this item. |
| `409` `not_ready` | The selected question is not ready, with its reason. Another ready question on the item stays answerable. |
| `409` `correction_required` | This reviewer already holds a current answer to this question; a new answer must link it. |
| `409` `stale_correction`, `not_correctable` | The link is not this reviewer's current answer to this question. |
| `422` `invalid_answer` | The answer is not one of the question's choices. |

A submission writes one completed execution and one observation. It needs no task, link, approval or
automatic grading, makes no provider request, and writes nothing to Oakridge. `GET /v1/reviewer`, with
the grade credential, names the reviewer that credential answers as.

The operator reaches these through kbbl's `/oakridge/observation/*` (`kbbl/core/server/handlers/observation-proxy.ts`),
a closed list of routes. kbbl applies its control policy and browser-write protections first, then
replaces every browser credential with the server-held capability the route needs, and forwards only the
request fields above. Hiding answers is a preference in that browser: no visibility or assignment record
exists, and no read depends on having answered.

## Oakridge profile

- **Items:** `finding` from each analysis finding and `assessment_finding` from each implementation or
  integration assessment finding, both addressed by revision and path. Item identity holds no task id.
- **Tasks:** one run-scoped logical item per `task_id`, from the `tasks` artifact. Plan and brief
  `acceptance_criteria` entries are occurrences of that logical item; their `id` is the task id. A task
  shared by cohorts stays one logical item, and the same id in another run is another item.
- **Links:** each id in an assessment finding's `task_ids` is one `assesses` edge to the logical task.
  An empty list is valid. An unknown id stays unresolved and resolves in place if the task arrives.
  Links are never inferred from requirement ids, feedback, text, timestamps or unit paths.
- **Late links:** an explicit analysis-link declaration (below) adds an edge to an original finding
  addressed by source revision and path, without touching the item, its pins, evidence or answers.
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
it advances the source cursor and creates no evidence, execution or answer. An approval creates no
link either.

## Analysis-link declarations

A declaration (`oakridge-dbos/src/domain/analysis-link-declaration.ts`) is a producer's explicit statement
that original analysis findings assess tracked tasks:

```json
{ "run_id": "...", "tasks_revision_id": "<exact approved tasks revision>",
  "entries": [{ "source_revision_id": "<analysis revision>", "item_path": "/findings/0", "task_ids": ["T1"] }] }
```

`POST /api/runs/:run_id/analysis-links` takes `request_id`, `tasks_revision_id` and `entries` under the
operator credential, and resolves the writer from that credential.

1. **No applicable entries, no declaration.** An entry with no task id is dropped. If none remain, the
   route answers `{ "kind": "no_declaration" }` and journals nothing. Missing links are valid and ask
   nothing of anyone.
2. **The exact context is checked under the run lock.** The named revision must be this run's `tasks`
   revision and have an `approve` decision of its own; a later approved revision does not stand in for it.
   Each source must be this run's `analysis` revision with a finding at exactly `/findings/<index>`.
   A refusal is a 409 with a stored receipt, so a replay returns it again.
3. **It is journaled, not stepped.** A valid declaration is one `analysis_links_declared` row in
   `authority.event`, holding the supplied payload. The core never sees it: it opens no attempt, changes no
   unit and starts no worker. It does not count as the run moving on, so a stall or fault still stands.
   No part of it reads requirement ids, feedback, text, timestamps or unit paths.
4. **It travels the one ordered feed.** The publisher maps the row to a `relation_declaration` outcome
   carrying the journaled payload, in the same `(commit_txid, id)` order as every other event, so an
   observation outage cannot touch the approval or the run.
5. **Observation projects it in the delivery's transaction.** The Oakridge profile reads the declaration
   (`observation/src/producers/oakridge/declarations.ts`); generic code receives only `RelationDeclaration`s.
   Each task id becomes one `producer_explicit` `assesses` edge to that run's logical task. The edges, the
   stored outcome and the cursor commit together, so a delivery applied before a lost acknowledgement is
   not applied again: the restarted publisher asks the service where it is and moves on, and a stale
   redelivery gets a 409.

An edge's identity comes from its source, the tasks revision and the task id, so the same statement declared
twice is one relation. The same statement against another tasks revision is a second path to the same
task, and a composite still counts the item once.

An unknown task stays an unresolved edge, visible, and resolves in place if that run captures the task. A
source this service holds no item for, or one in another run, gets no edge: it is kept on the stored outcome
as `projection.unresolved_sources`, read with `readRelationDeclarations`, and the cursor still advances. A
declaration the profile cannot read is recorded as `unmapped`.

A declaration starts no reconciliation, so a link can never admit, retry or send anything. It leaves the
item, its pins, frozen evidence, answers, executions, provider attempts and request counts as they were.

**The caller.** The approved-tasks caller is the tasks review's own decision:
`POST /api/runs/:run_id/units/:unit_id/reviews/tasks_review/decide` takes an optional `analysis_links` list of
`{ source_revision_id, item_path, task_ids }`. The declaration names the revision the decision targets, and
commits in the decision's transaction, so a crash cannot leave one without the other. Supplying nothing is the
ordinary case: nothing is journaled and the response is unchanged. A refused entry refuses only the
declaration, which the response reports as `analysis_links: { "kind": "refused", "reason": ... }`, and the
decision stands. A retried request answers from both receipts. `operator_decided` still maps to ignored; only
the separate declaration event carries associations. `POST /api/runs/:run_id/analysis-links` stays for links
supplied after that approval.

**What does not supply them.** Neither `tasks` nor `analysis` carries an association, and no agent step
produces one, so a run gets late links only when a decision's caller supplies them. Having agents declare
them needs a `tasks` artifact field or an agent output, which is an operator decision.

## Composites and lineage

`observation/src/grading/composite.ts` holds the pure transforms, and the read functions in
`observation/src/storage/grading-record-store.ts` run them over one repeatable-read snapshot of a run. Nothing
is stored. The profile's `composite` path names the logical scope, relation type, contributing item kinds,
stages and `stageOf`. For Oakridge the stages are `analysis`, `implementation` and `integration`. An
assessment's stage comes from the declared unit in its recorded `unit_id`, which never enters an item's
identity.

**Current selection.** Each unit's artifact is one stream with one current revision: the latest recorded
that no revision in the stream names as its predecessor. This is decided per stream and before links are
read, so every cohort keeps its own current revision, and a newer revision with no links replaces an older
linked one instead of resurrecting it. Superseded revisions stay readable in history.

**Answers.** A superseded answer is dropped from the counts by its own correction chain, never by
recency across graders, and stays in history. Counts are per question version, per machine evaluator or
human reviewer, per answer. Allowed values come from the registered question, so generic code holds no
producer vocabulary.

**Stages.** Stages stand side by side and nothing adds across them. A stage is `pending` until one of its
revisions publishes. A stage marked final on publication is then `{ state: "published", is_final: true }`,
whatever its answers, links or approvals. No current linked item is `coverage: "gap"`, in a stage and for
the whole task; it is never a pass or a zero.

**Status is not an answer.** `statuses` counts what is not an answer, with `totals` counting distinct items:

| Status | Meaning |
| --- | --- |
| `not_ready` | The question's own wait, with its real code. Counted once per item and question, with no evaluator. |
| `grading_off` | The run's launch chose no automatic grading. |
| `awaiting_admission`, `pending` | Ready, and not answered yet. |
| `budget_deferred` | The next request could not fit the run's allowance. |
| `failed` | Ended with no answer, with its terminal cause. |

A negative answer or a chosen `unclear` is an answer, and a human with no answer yet owes nothing, so has
no status.

**Disagreement** is differing current answers on one occurrence and question. Different items answering
differently is not disagreement, and neither is a corrected answer differing from its correction.

| Read | Returns |
| --- | --- |
| `readLogicalItemComposite`, `listRunComposites` | `LogicalItemComposite`, its stages and counts. A count carries its `drilldown` key. |
| `readCompositeDrilldown` | `Paged<DrilldownRow>`: the exact items behind a count, with frozen evidence, statuses, current and superseded answers. |
| `readLogicalItemLineage` | `LogicalItemLineage`: the task's list, plan and brief occurrences at exact revisions and paths, their declared edges, its linked items by stage, and unresolved references. |
| `listRunUnlinkedItems`, `listRunUnresolvedReferences` | Items linked to nothing, and edges naming a target not captured. |

Every returned list is `Paged` with the whole list's `total`, and each read is scoped to its tenant and
run. A drilldown takes its own window for each of `rows`, `questions`, `links`, `statuses`, `answers` and
`superseded_answers` (`DrilldownPages`), so a reader can continue any one list while holding the others
still. An answer count is of items, and its drilldown `total` equals the count, because rows are chosen before the page is cut. A
stage's count lists are complete summaries rather than pages, and each of their entries opens as a paged
drilldown. These reads need no submission, assignment or reveal record. The HTTP forwarding,
item navigation and panel belong to the later operator cohort, on these same contracts.

## HTTP routes

The ingest credential uses `GET /v1/sources/oakridge/cursor` and `POST /v1/sources/oakridge/events`.
The grade credential uses `POST /v1/items/:id/answers` and `GET /v1/reviewer`. The read credential uses:

- `GET /v1/sources/oakridge/unmapped`, `GET /v1/source-revisions/:id`
- `GET /v1/runs/:run_id/items`, `GET /v1/items/:id`, `GET /v1/items/:id/lineage`, `GET /v1/items/:id/grades`
- `GET /v1/runs/:run_id/items/at?source_revision_id=&item_path=`: one item by its exact address, with no task or cohort
- `GET /v1/items/:id/status`: each pinned question's definition, own readiness, frozen evidence, each machine evaluator's state and attempts, every answer and correction history, and the item's explicit links
- `GET /v1/items/:id/answers?question_id=&question_version=&reviewer_id=`, `GET /v1/items/:id/evidence`
- `GET /v1/runs/:run_id/grading-spend`: the run's choice, spend, request count and execution statuses
- `GET /v1/runs/:run_id/gradeable-items?stage=&revisions=all`, `GET /v1/runs/:run_id/unlinked-items`, `GET /v1/runs/:run_id/unresolved-references`
- `GET /v1/runs/:run_id/logical-items`, `GET /v1/runs/:run_id/logical-items/:local_id`, `.../lineage`, `GET /v1/runs/:run_id/composite-drilldown?key=`
- `GET /v1/questions/:id/versions/:version`; `GET /v1/evidence-sets/:id?references_limit=&pinned_evaluators_limit=`: one frozen evidence set in the same paged shape as an item's evidence
- `GET /v1/evaluations/by-digest/:digest`, `GET /v1/evaluation-executions/:id` (also the grade credential)

Every read carries its credential's tenant and needs only the read credential: none is unlocked by an
answer. Every returned list is paged. `limit` and `offset` window the list itself, up to 200; a nested list
has its own `<name>_limit` and `<name>_offset`, so a reader continues it while holding the others still. A bad
window refuses the read rather than clamping. Each page says its `total`. Question choices are part of the
definition and are not paged. An unknown task id is a 404 from the logical-item route and stays visible as an
`unresolved` link on the items that named it.

The types are in `observation/src/grading/item-reads.ts`, and `kbbl/core/pwa/oakridge/grading-types.ts` mirrors
them for the PWA. kbbl serves the same reads under task names: `/runs/:run_id/tasks`, `/findings`,
`/unlinked-findings`, `/unresolved-task-references`, `/drilldown` and `/grading`.

## Verification

Offline, from the repository root, with `OAKRIDGE_TEST_DATABASE_URL` naming a local PostgreSQL:
`bun run --filter observation test` and `bun run typecheck`. No storage record changed, and
`bun run --filter observation storage:check` passes against the existing baseline. No authority or
observation baseline, core contract or generated definition changed for declarations or composites.

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
  citations, the assessment's reported test results with `cargo_test_output` for both questions,
  integration without a subject and without task context, task context and frozen shared evidence.
- `observation/tests/provider-input.test.ts`: the request `jev_direct`, `fastino_glide` and
  `llm_judge` each send through an injected transport, holding every reference's provenance, an
  absent file as `is_absent: true` and the reported test results; and the committed instructions
  naming that shape.

- `oakridge-dbos/tests/analysis-link-declaration.test.ts`: the exact approved revision, a newer unapproved
  one, another run's addresses, replayed and reused ingress ids, the route with nothing applicable, standing
  stalls, and through the real feed, failed delivery, a lost acknowledgement, stale redelivery and repeats.
- `oakridge-dbos/tests/observation-process-restart.test.ts`: a real publisher process killed before a
  declaration is applied, and after it is applied but before its acknowledgement, each delivering it once
  when restarted.
- `observation/tests/relation-declaration.test.ts`: what a declaration decodes to, unchanged items,
  repeats, unresolved targets, absent and other-run sources, tenant isolation and unmapped declarations.
- `observation/tests/composite.test.ts`: a finding graded before tasks and linked late beside an unlinked
  control, one task through two cohorts and revised plan and briefs, newer empty revisions, stages,
  integration pending then final, corrections, disagreement, every status, unknown tasks, duplicate
  paths, page boundaries with nested lists, and run and tenant scope.

On the shadow, through `observation/verification/proof.ts`:

- `relations` passed all 68 checks (`observation/verification/reports/relations-2026-11-08T20-31-17-449Z`)
  at `100000b5`, with real provider answers, 44 real requests across two runs. Later fixes (a count of items rather
  than rows, the namespace of a decision's link receipt, and the proof repeating a decision under one id until
  its result is known, and failing if a step it asked for never ran) are covered by offline tests, not by this
  report.
- Its first run, `run-8734e674c984b0f3` from `inputs/relations-audit.json`, measures the late link. 5 analysis
  questions were answered in 5 requests before the run had any task. A mapping naming the unapproved tasks
  revision was refused, the approval changed nothing, and every task read as a coverage gap. After the mapping
  was delivered, its composite opened the original observation, with the item, pins, evidence, measurements,
  answers, the unlinked control and the request count all unchanged. A second mapping was journaled with
  observation killed and the whole stack restarted before any acknowledgement: it arrived once, with 19 requests
  before and after, and the authority's events went from 43 to 44, the mapping alone.
- Its second run, `run-ac2e5f66cae38631` from `inputs/relations-shared-audit.json`, is the real shared task. Its
  tasks approval itself carried explicit links, delivered as one declaration with the 5 requests unchanged. Its
  plan and both briefs were sent back and really revised. Cohorts `alpha` and `beta` both reached their
  assessments, and `T1` reads 2 analysis findings and 6 implementation findings across both cohorts, all
  answered, 25 requests in all. One finding reads under both `T1` and `T2`, the unknown task stays a visible
  reference, the control stays unlinked, and integration reads pending. Its lineage holds the task list, both plan
  revisions and both revisions of each brief. Every count opened as many rows as it reported, and one-entry windows
  reached every nested question and raw answer.
- **What that proof does not show.** No real run published integration. A cohort completes only on an operator's
  acceptance of its assessment and confirmation of a merge, and this proof does not make those decisions by itself.
  The report's `shared_task_matrix` is a supplement for integration final, corrections and disagreement, on the
  shadow's database through real ordered delivery, in a tenant of its own, on **synthetic** revisions and answers,
  and is labelled so. No provider request is made for it. Both shared-run assessors returned `fail` because their
  environment had no test database for the suite the audit spec asks them to run, which says nothing about the
  reads above. A lost acknowledgement is proven against a real process in
  `observation-process-restart.test.ts`, not on the shadow. The human and PWA continuation is the `workspace` proof.
- **Operator proof.** `workspace` passed all 60 checks (`observation/verification/reports/workspace-2026-11-09T04-00-03-424Z`)
  on a freshly started service. On real run `run-d71318e8959a6801`, assessment finding
  `run-d71318e8959a6801/implementation/audit:assessment:1` `/findings/2` was answered by the configured provider in
  a real request and by an authenticated reviewer, both read back in the PWA with nothing but that address. Corrections,
  duplicates, spoofing, a refused not-ready question, grading off, hidden and revealed views and each viewer entry point
  are in its checks, with 20 provider requests and 61 authority events unchanged by every human answer. An earlier attempt on
  an empty database (`workspace-2026-11-09T02-14-08-499Z`) passed its registration, capture, provider, human and readback
  checks, then failed on a stalled browser click; it and `workspace-2026-11-09T00-54-15-507Z`, which failed on faults in the
  proof's own script, are kept as they ran.
- **Current cumulative state.** `reports/cumulative-2026-11-09T04-24-32-505Z` reads **failed**, because its `relations` report
  (`relations-2026-11-09T03-23-51-515Z`) failed 3 of 68 checks: its unchanged-facts snapshot then included an item's links,
  which a late link is meant to change. The fix is at `8c96d05a` and unit-tested, and **`relations` has not been rerun with it**, so that
  scenario is incomplete. `grading-2026-11-09T02-36-25-820Z` passed 97 of 97. Real integration findings need an operator's merge
  and are read only on labelled synthetic revisions and browser fixtures. The shadow's kbbl runs in its loopback control policy, so
  token authentication is proven by the real forwarding code in-process against the real service.
- **A side effect to know before rerunning.** Audit assessors follow `assess.md`, so they call `set_pr_draft` on
  the real pull request the audit input names. A proof run can therefore flip that pull request's draft state.
- Earlier `relations` runs (`relations-2026-11-08T17-31-33-853Z`, `relations-2026-11-08T17-46-21-583Z`) predate the
  real shared run.
- `live` passed (`observation/verification/reports/live-2026-11-07T16-59-47-486Z`): the service
  started from `graders.json` and reported its three configured graders.
- `registration` passed (`observation/verification/reports/registration-2026-11-07T18-48-17-496Z`)
  on two real development runs through assessment, using `inputs/registration-audit.json`, at
  `cdeba035`. The first run (`run-0e8c1a1cef8a656f`) reached its assessment with observation down.
  With its launch repository withheld, observation captured all 45 of its events: 11 questions were
  pinned to the committed selection, the 6 that cite files waited with `repository_unavailable`, and
  the other 5 were ready. After a `graders.json` edit and restart, 3 new definitions were registered
  and all 13 were stored; the first run kept every pin and frozen set, and the 6 still waited. With
  the repository supplied and a restart, all 6 became ready on their capture-time pins, reading 20
  file references at commit `cdeba035`. The second run (`run-3580ddecfbcd6c6c`) was pinned to the
  edited selection. Its 5 analysis findings' Relevance evidence froze before the run's tasks
  existed, and stayed unchanged through the tasks, plan, brief and assessment revisions and their
  task links, across 79 reads. No execution, provider attempt or answer exists. On a real run the
  ordered feed captures a build before its assessment, so the same finding with Correctness
  waiting and Evidence support ready is not observed live (0 seen); it is proven through the real
  service in `observation/tests/grading-startup.test.ts`.
- Two earlier runs with that input stalled before any capture
  (`registration-2026-11-07T18-03-10-914Z`: the brief made the audit wait for an operator choice;
  `registration-2026-11-07T18-34-34-328Z`: `build_base` was the pull request's own branch, not its
  base).
- The earlier `registration` without `--input`
  (`observation/verification/reports/registration-2026-11-07T17-00-48-602Z`) recorded both
  startups' registrations, three new definitions after the edit with every earlier one kept, and
  no execution or provider request.