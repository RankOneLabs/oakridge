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
| `ItemOccurrence` | `item_occurrence` | One selected item, addressed by revision and path. A per_task grading subject also names its task. |
| `LogicalItem` | `logical_item` | One thing tracked across revisions, scoped to a run. Optional. |
| `ItemRelation` | `item_relation` | A directed edge the producer stated. An unresolved target stays visible. |
| `ExtractionIssue` | `extraction_issue` | A failed selection. |
| `QuestionDefinition` | `question_definition` | Versioned wording, its `item_kind` and its answers. |
| `EvaluatorDefinition` | `evaluator_definition` | One grader: human, or a runner with a model and instructions. |
| `EvidenceSet` | `evidence_set` | One occurrence, nullable task and question: the capture pin, readiness and frozen evidence. |
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

`evidence_set` has one row per grading subject and question version. For a `per_item` question,
the subject is the occurrence and `task_id` is null. For a `per_task` question, the subject is
(occurrence, task): `task_id` is the task's logical_item_id, and the grade belongs to exactly one task.
Resolved `assesses` relations under the declared `task_ids` pointer create one subject per distinct task.
Missing or unresolved links create no task subject; resolving a link later creates its subjects then,
using the capture configuration in force at resolution. Existing pins never change.
The row *is* the pin: it names the question version and, in `pinned_evaluator_definition_ids`, the
full evaluator set applicable when that subject was first pinned. Pins exist whether or not evidence is
available and whether or not automatic grading is on, and they create no execution.

A capture pins only a newly stored occurrence, so a replay under a later configuration does not
repin it. Later configuration reaches later captures and newly resolved task subjects. Question and evaluator definitions are
append-only, so a pinned definition stays readable across restarts; a change is a new definition,
never an edit.

`readiness` starts as `not_ready` with the reason `collection_pending`. Each question moves on its
own: collection records either a retryable `not_ready_code` and `not_ready_detail`, or `ready` with
its references. Ready evidence is frozen by trigger and shared by every evaluator of that subject. A later link never
changes it.

`ArtifactSource.collect` takes the occurrence, task and question and returns ready references or a
not-ready reason. A failed required lookup delays only the question that needs it.

The pins a capture writes come from the registration made at startup, so a `graders.json` edit takes
effect at the next restart and reaches later captures and newly resolved task subjects. A subject pinned
earlier, ready or not, keeps the question version and evaluator set it was pinned with; when its
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
occurrence, task and question and the occurrence in the same run. Evidence-set and execution digests
include the nullable task, so subjects of different tasks cannot deduplicate. Lifecycle fields move through `queued`,
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
requires it to measure the same occurrence, task, question, evidence and evaluator for the same reviewer,
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
  their task-specific answers; per_item grades appear only as linked context. A composite is a read and creates no record.

| Item kind | Question | Evidence | Answers |
| --- | --- | --- | --- |
| `finding` | Relevance | The finding (`subject`) and the full captured launch spec (`spec`) | `relevant`, `irrelevant`, `unclear` |
| `assessment_finding` | Correctness | The finding, its citations, the assessment's reported test results, the exact `subject_id` build when set, and available linked task context | `supported`, `contradicted`, `unclear` |
| `assessment_finding` | Evidence support | The finding, its citations and the assessment's reported test results | `supports`, `does_not_support`, `unclear` |
| `task` | Spec requirement coverage | Task, approved spec and explicitly referenced requirements | `fully_covers`, `partially_covers`, `does_not_cover`, `unclear` |
| `acceptance_entry` | Spec task coverage | Contribution, spec task, requirements, combined plan and cohort or brief context | `fully_covers`, `partially_covers`, `does_not_cover`, `unclear` |

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

Risks and decisions are captured but not graded. Whole artifacts and verdicts have no direct
grade. Spec tasks and cohort contributions have the coverage questions below. A missing task, link or approval never makes a question wait; neither does an integration
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

**Answers.** A task composite counts only grades whose `task_id` is that task's logical_item_id.
One finding naming T3 and T7 has independent subjects: a T3 answer never appears in or counts toward
T7. Missing evaluations stay missing and never imply a pass. Per-item grades of linked items remain
visible in the items drilldown as `is_linked_context: true`, excluded from task-level answer and status counts.

A superseded answer is dropped from the counts by its own correction chain, never by
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

**Disagreement** is differing current answers on one occurrence, task and question. Different items answering
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

Live verification uses `observation/verification/proof.ts`; see the
[verification instructions](../observation/verification/README.md) for scenarios
and commands. Generated reports and captured run data stay local and are not
committed.

Audit assessors follow `assess.md`, which can change the draft state of the real
pull request named by an audit input. Choose the audit target accordingly.

## Spec task and cohort contribution coverage

A **spec requirement** states required behavior. A **spec task** is an overall work obligation explicitly written in the approved spec and mirrored by the tasks artifact. A **cohort contribution** is a plan or brief acceptance entry whose `id` names that same spec task; it is not a second task identity. Several cohorts may contribute to one spec task.

`task.requirement_coverage` grades each `/tasks/*` item against the complete requirement records explicitly named by its `requirement_ids`. `acceptance_entry.task_coverage` grades each plan and brief acceptance entry against its canonical spec task. Evidence includes the captured revised spec, the complete referenced requirement records, the original task definition, the combined plan and the surrounding cohort or brief. A plan contribution is judged as its declared share of the combined plan. A brief contribution must preserve that share and be concrete enough to implement. Neither question judges completed implementation.

Both questions offer `fully_covers`, `partially_covers`, `does_not_cover` and `unclear`. An empty requirement list gives no inferred links; the grader is instructed to answer unclear for task coverage. A named requirement or task that is absent makes the question not ready. Context is selected at the graded revision's recorded position within its tenant and run; later spec, task-list or plan revisions are excluded, and ready evidence remains frozen.

The task, plan and brief viewers each open the same item grading panel at an exact revision and path. Partial coverage has a distinct glyph. Existing finding assessment composites retain their meaning; definition and contribution coverage opens separately from the spec task's lineage. New questions are pinned on new captures. An explicit operator-requested upgrade may add coverage questions to previously ungraded task/contribution occurrences, using the normal immutable evidence rows and ordinary reconciler; existing question pins, answers and frozen evidence are never changed.
