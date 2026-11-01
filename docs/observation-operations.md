# Observation operations

The [Langfuse pilot decision record](spec-03-langfuse-pilot.md) pins the
external projection contract and the five operator recommendations.

The observation service stores its own PostgreSQL data. Oakridge remains the
workflow authority. Start the service with `OBSERVATION_DATABASE_URL` and
`bun run --filter observation start`; it binds to `127.0.0.1:8791` unless
`OBSERVATION_HOST` or `OBSERVATION_PORT` is set. `scripts/oakridge-start
--observation` starts it alongside DBOS and kbbl, reading `OBSERVATION_DATABASE_URL`
and any `OBSERVATION_LANGFUSE_*` settings from `observation/.env`; it stops before
starting anything when that file names no database. Without the flag the service
is not started.
For an independent Springfield deployment, run the same package with its own
database, credentials and network binding, then point the Oakridge publisher
at its URL. That deployment topology is documented here, not automated.

## Producer ingest credential and scope

Configure `OBSERVATION_INGEST_CREDENTIALS` as a JSON array of
`{"producer":"oakridge","namespace":"development","token":"<secret>"}`
entries. Give DBOS the matching `OAKRIDGE_OBSERVATION_NAMESPACE`,
`OAKRIDGE_OBSERVATION_INGEST_TOKEN`, and `OAKRIDGE_OBSERVATION_URL`. DBOS
does not construct the publisher when the URL is absent. With `--observation`,
the start script wires both sides itself: it keeps one ingest token in
`~/.local/state/oakridge/observation-ingest.token`, generated on first start,
sets `OBSERVATION_INGEST_CREDENTIALS` for the service to that token under
producer `oakridge` and `OAKRIDGE_OBSERVATION_NAMESPACE` (default `default`),
and gives DBOS the matching token and `http://127.0.0.1:${OBSERVATION_PORT:-8791}`.
Without the flag, an exported publisher URL and token pass through to DBOS
unchanged, for a separately deployed service. An ingest token may
only submit and inspect its configured producer and namespace through the
source routes; it cannot read item history, grade, or export. Configure
separate tenant-bound arrays `OBSERVATION_READ_CREDENTIALS`,
`OBSERVATION_GRADE_CREDENTIALS`, and `OBSERVATION_EXPORT_RAW_CREDENTIALS` for
those capabilities. Tokens must be unique across all four arrays. Keep them in
the runtime secret store, outside checked-in configuration and logs. Credentials
are configuration-sourced; rotation means replacing the configuration and
restarting the service and publisher together.

## Langfuse pilot configuration and disable path

The pilot uses platform `fetch` and adds no package dependency. Its deployment
choice is pending: no Langfuse Cloud region or self-hosted URL and project keys
were provisioned for the adapter cohort's Phase A run. Set
`OBSERVATION_LANGFUSE_BASE_URL` to the chosen HTTPS origin,
`OBSERVATION_LANGFUSE_PROJECT_ID` to the project ID, and
`OBSERVATION_LANGFUSE_PUBLIC_KEY` and `OBSERVATION_LANGFUSE_SECRET_KEY` to an
independent project-scoped key pair. Set
`OBSERVATION_LANGFUSE_ANNOTATION_QUEUE_ID` and
`OBSERVATION_LANGFUSE_DECISION_EVALUATOR_ID` only after the queue and pinned
decision-model evaluator have been verified on that deployment. The Phase A
synthetic run also requires `OBSERVATION_LANGFUSE_DECISION_MODEL` and
`OBSERVATION_LANGFUSE_PHASE_A_JEV_SCORE_NAME`, matched to that evaluator's
configured model and score question. Optional
`OBSERVATION_LANGFUSE_MAX_ATTEMPTS` (1–5, default 3) and
`OBSERVATION_LANGFUSE_BACKOFF_MS` (0–5000, default 200) bound transient HTTP
retries. Give this key only the trace/score ingestion and read, evaluator read,
and annotation queue access needed for this project. Keep both keys in the
runtime secret store outside checked-in configuration and logs; rotate them
there and restart the service. Error details name fields and HTTP status only,
never the supplied key or response body.

Use the existing tenant-bound `OBSERVATION_GRADE_CREDENTIALS` token for
`POST /v1/langfuse/projections` and `POST /v1/langfuse/reconcile`, and an
`OBSERVATION_READ_CREDENTIALS` token for `GET /v1/langfuse/status`. Projection
loads the frozen execution, question, evidence and source revision for that
tenant and applies a restrictive disclosure policy. It remains pending until
`OBSERVATION_LANGFUSE_PHASE_A_TRACE_ID` names the trace of a passing
`langfuse-capability-spike.ts --write-synthetic` run on this project; it then
writes one OTLP span per mapping and responds `202` with `{ "status":
"written", "trace_id", "observation_id" }`. Evidence references marked
`kind: "public"` carry their content into the span; other kinds are redacted
under the restrictive policy. The status
route lists the latest 100 mapping states for the caller's tenant.

Removing all `OBSERVATION_LANGFUSE_*` settings and restarting selects the
disabled variant. No `/v1/langfuse/*` route is mounted; authenticated reads
to those paths receive `404`. Producer ingest, local projections,
lineage and previously stored grades continue through their existing routes.
Restore the settings and restart to re-enable the adapter; pending mappings
remain in the observation database for reconciliation.

The historical `langfuse-pilot-run.ts` script uses `OBSERVATION_PILOT_BASE_URL`,
`OBSERVATION_PILOT_GRADE_TOKEN` and `OBSERVATION_PILOT_READ_TOKEN`. It reads
eligibility through `GET /v1/evaluation-eligibility`, execution and grade
readback through `GET /v1/evaluations/by-digest/:digest` and
`GET /v1/items/:id/grades`, and item provenance through authenticated item
and source-revision routes. It does not connect to PostgreSQL directly.

## Sensitive inputs, redaction and export gating

Captured L0 revision bodies and evidence references can contain prompts,
repository content, build output and test output. Restrict database access and
avoid logging request bodies. `POST /v1/exports/assay` with a read credential
defaults to a redacted dataset. It withholds raw build output, raw test output,
repository content, and unclassified build-result fields, recording each path
and reason in the frozen manifest. Evidence with no captured content, incomplete
evidence, and unanswered grades are excluded with explicit reasons. Allowing
any raw content class requires the separate tenant's raw-export token. Review
both `manifest.json` and `candidates.jsonl` before transferring them; the
manifest's membership digest and JSONL byte hash detect later changes. See
[the export contract](observation-assay-export.md) for the exact format.

## Retention and purge

Archiving a run retains its observations and leaves it gradeable. A committed
run deletion emits an operator invalidation; the service purges only after
Oakridge confirms that the run no longer exists. Purge removes the captured
revisions and their projections, grades and source rows in one transaction and
retains a `purge_event` with removed-row counts. A run mentioned by any frozen
export membership blocks purge, including an excluded candidate. An explicit
`operator_override: true` delivery may allow purge and records the affected
manifest IDs; the normal publisher never sends that override. The frozen
manifest remains, but evidence removed by the override cannot be reproduced.
Back up the observation database under the operator's retention policy before
purging; the service has no undo operation. Access revocation is specified in
[retention](observation-retention.md) but has no command in this pass.

## Namespace isolation

Every source revision, occurrence, grade and export is scoped by
`(producer, namespace)`. A credential grants one capability in one scope, and
cross-namespace references are refused. Use a distinct namespace for each
environment or trust boundary. The publisher and service credentials must name
the same pair. Changing a namespace creates a separate cursor and data set;
it does not migrate or rename the old one. Keep old credentials available only
as long as that namespace needs reads or recovery.

## Wire-format and extractor-version upgrades

The current source event and artifact envelope formats are
`observation.source-event/v1` and `observation.artifact-revision/v1`. Each
captured revision pins its artifact schema version and definition bundle digest;
the catalogue also records its extractor ID and version. Service startup applies
the package's additive PostgreSQL migrations; take a database backup before a
version rollout. Before changing a
wire format, deploy a decoder that accepts both versions, verify replay from a
fixture of the old producer, then change the publisher and retire the old
decoder only after its cursor has passed the rollout. A new selection rule
gets a new extractor version; project historical revisions deliberately into
that version and compare occurrence counts, issue rows and lineage before
using its IDs for grading or export. Never reinterpret existing occurrence IDs
in place. An unmapped event is persisted with a reason and advances the cursor
after acknowledgement, so inspect `GET /v1/sources/oakridge/unmapped` after
upgrades. The checked-in `run-slice` fixtures cover the current explicit-ID
contract and mark which event fields came from the historical producer.

## Failure modes and observed outage drills

The publisher reads the service-held `(commit_txid, event id)` cursor. Its
acknowledgement commits the outcome and cursor together; an unacknowledged
delivery is retried from that cursor. These checks live in
`oakridge-dbos/tests/observation-publisher.test.ts` and
`oakridge-dbos/tests/observation-process-restart.test.ts`.

### Adapter restart

The drill stopped and recreated the adapter mid-tail. It resumed from the
service cursor and delivered every committed event ID once. There was no
second artifact revision or lost feedback. A stale cursor response makes the
publisher read the current service cursor again.

### `oakridge-dbos` restart

The drill reopened the Oakridge database handle mid-tail; a separate drill
stopped and restarted the actual DBOS process between commits. Both delivered
the committed event ID set after restart, with the artifact revision and human
feedback intact. The service's cursor, not a DBOS-local resend buffer, defined
the resumed position.

### Observation-service outage spanning an adapter restart

Oakridge continued committing events while the adapter logged delivery errors.
The service cursor stood at the last acknowledged event. After both the service
and adapter returned, the publisher read the pending cancellation and the
delivered ID set matched the committed set. The artifact revision remained
single and human feedback was intact. Lag is the committed event range after
the service cursor; inspect `GET /v1/sources/oakridge/cursor` and the publisher
warning log when it grows.

The event-order drill held an older transaction open past a newer commit; the
publisher waited until both were visible and delivered each once in commit
order. Unknown variants and undeclared artifacts were recorded as queryable
unmapped outcomes, rather than silently dropped. Historical labels and
collaboration comments can be resumed with
`bun run --filter oakridge-dbos ops -- observation-backfill <max_rows>`; the
service stores its backfill position and active/archived counts after each row.

### Langfuse outage and replay (local database, simulated remote outage)

`observation/tests/langfuse-outage-replay.test.ts` ran against a scratch
PostgreSQL database. It stored a deterministic grade, pinned one Langfuse
mapping with external IDs, made the remote score endpoint return HTTP 503,
and read the local grade during the outage. After restoring the stubbed remote
score endpoint, it replayed the same mapping and reconciled twice. The grade
observation ID was unchanged, one mapping retained the same trace, observation
and score IDs, and the second reconciliation made no remote read. This tests
local recovery and idempotency; it is not a measured outage of a live Langfuse
deployment. The current projection method still refuses outbound writes until
the Phase A synthetic write/readback gate is completed on a real deployment.

### Langfuse adapter disabled (local database)

The same test file created the service with the adapter disabled, called the
external `POST /v1/evaluations` grading contract, read its raw grade, and
created a frozen Assay export through `POST /v1/exports/assay`; each returned
success and the export included the graded occurrence. `GET /v1/langfuse/status`
now returns `404` with the adapter disabled. The existing `langfuse-offline.test.ts` drill also ingested
a revision, projected an item, read lineage, accepted a human grade and read it
while Langfuse routes were disabled. These are local service drills. No live
Oakridge workflow or production deployment was restarted for this cohort.

## Durable grading queue

`POST /v1/evaluation-jobs` accepts a pinned evaluation identity, optional context,
runner name and estimated cost, then returns a durable `job_id`. Network-backed
runners are accepted only on this route. `POST /v1/evaluations` remains for the
local deterministic, coverage and stub runners. Read or grade credentials can
read `GET /v1/evaluation-jobs/:id`, `GET /v1/evaluation-executions/:id`, and
`GET /v1/items/:id/evaluation-jobs` to inspect pending and terminal work.
If a manual request leaves an execution running after interruption, a grade
operator can call `POST /v1/evaluation-executions/:id/recover`. The action
marks that manual execution failed and fences out its late response. Submit
a new manual evaluation with a distinct `attempt_label` to produce the grade.
The recovery action refuses executions owned by a durable job and executions
that are already terminal.

The observation process starts a worker beside HTTP. It claims queued or
expired jobs with `FOR UPDATE SKIP LOCKED`, checks run and stage caps, then
starts one canonical running execution before calling the runner outside every
database transaction. The persist transaction rechecks the lease owner and
expiry before completing the execution and inserting the grade. An expired
response is discarded. The worker can be stopped independently of HTTP by
calling the returned worker's `stop()` method; process shutdown stops it before
closing the database. Returned provider request IDs and costs are appended to
`evaluation_execution.provider_attempts` for successful and failed requests,
including a late response discarded for its expired lease. Each entry records
its attempt number and outcome.

The default caps are two active jobs per run, one per stage, 1 unit of run
spend, 0.5 units of stage spend, three attempts, a 30 second provider deadline
and a 45 second lease. Set `OBSERVATION_GRADING_RUN_CONCURRENCY`,
`OBSERVATION_GRADING_STAGE_CONCURRENCY`, `OBSERVATION_GRADING_RUN_SPEND`,
`OBSERVATION_GRADING_STAGE_SPEND`, `OBSERVATION_GRADING_RETRY_LIMIT`,
`OBSERVATION_PROVIDER_DEADLINE_MS`, and `OBSERVATION_GRADING_LEASE_MS` to adjust
them. The lease is never configured shorter than the provider deadline plus
five seconds. Active jobs reserve their estimated cost; after a job releases
its claim, its recorded provider cost remains in the spend total. Budget skips
before a first attempt create no execution; they append a
`skipped_budget` eligibility decision. The disclosure record stores provider,
policy version, evidence digests and content types, with no raw content. Only
public and classified repository content are permitted for outbound grading;
unclassified, internal, raw build and raw test roles are refused.
A provider attempt is recorded as `dispatched` at its admitted estimate *before*
the provider is called, and settled in place with the real outcome afterwards, so
one call is charged once whether or not it reached the provider. Budget admission
counts a `dispatched` attempt only while its job holds no live lease: in flight the
reservation already accounts for it, and once the lease lapses the attempt record
is the only thing standing between an interrupted paid call and a second admission
against zero recorded spend. A worker that dies before the dispatch record is
written never reached the provider, so nothing was paid.
Each attempt also records the `estimated_cost` admission reserved, so it explains
its own charge. When a provider reports a cost above that estimate, the attempt
carries `cost_overage` with the difference: the cap was checked against the
estimate, so that is the amount by which the single call overshot it. Recorded
spend carries the real cost, so later admissions self-correct; the overage is not
retractable and is recorded rather than prevented. No overage is recorded when the
provider reports no cost, because then the charge is the estimate, nor for a local
runner enqueued without an estimate, which reserved nothing to overshoot.
When a provider does not report cost, the admitted estimate is charged to its
attempt. If a retry is refused by a cap, the job becomes terminal and its
earlier running execution is closed as failed; the retry does not call the
provider. Local runners do not pass through the outbound disclosure gate.

The PostgreSQL drills in `observation/tests/grading-job-recovery.test.ts`
simulate interruption before claim, during a provider call, after response
before persist, and during restart. The same file verifies that an expired
response cannot replace the winner's grade. `grading-no-transaction.test.ts`
traces transaction callbacks around both the manual and queued runner call.
These are local deterministic drills, not a live provider rollout.

### Direct Jev live walkthrough (2026-10-30)

Using the local `TYPESAFE_API_KEY`, `GET /v1/models` returned `jev-latest` and `jev-preview`. A single `plan.criterion_traceability/v1` grade used the `criterion-lineage` plan subject and its cited `decision-capture` from `observation/fixtures/oakridge/run-slice/plan-revision.json`. The source event IDs and transaction metadata came from a captured Oakridge run; the fixture's revision bodies are hand-written adaptations, as its `PROVENANCE.md` states. The plan revision was ingested through the Oakridge source-event route, and the subject was projected before registration and grading. The four pinned pilot `input_recipe` values were unchanged.

The POST to `https://api.typesafe.ai/v1/systemone` used bearer authentication and this request shape (the full instruction text is stored on the evaluator):

```json
{
  "model": "jev-latest",
  "state": {
    "plan_criterion": { "id": "criterion-lineage", "text": "Lineage is explicit", "task_ids": [], "decision_ids": ["decision-capture"] },
    "plan_decision": { "id": "decision-capture", "text": "Keep captured bodies immutable" }
  },
  "questions": {
    "plan.criterion_traceability": {
      "type": "choice",
      "instructions": "Does plan_criterion follow from its cited plan_decision? Choose traceable when the decision supports the criterion; unsupported when it does not; unclear_insufficient_evidence only when the present excerpts cannot settle the relationship. Do not infer uncited sources.",
      "criteria": {
        "traceable": "The cited decision supports the plan criterion",
        "unsupported": "The cited decision does not support the plan criterion",
        "unclear_insufficient_evidence": "The captured excerpts do not settle support"
      }
    }
  }
}
```

TypeSafe returned HTTP 200 with `model: "jev-1.14.0"`, choice `unsupported`, confidence `0.37`, probabilities `{traceable: 0.15, unsupported: 0.58, unclear_insufficient_evidence: 0.27}`, and usage `{input_tokens: 483, output_tokens: 55}`. The five requested execution fields were checked independently in the stored row:

| Field | Stored value |
| --- | --- |
| Raw provider answer | `unsupported`, confidence `0.37`, and all three probabilities in `reproducibility_metadata.raw_answer` |
| Provider model version | `jev-1.14.0` in `reproducibility_metadata.provider_model` |
| Token usage | `input_tokens: 483`, `output_tokens: 55` in `model_usage` |
| Provider-reported cost | `null`; absent from the JSON response |
| Provider request ID | `null`; `id` was absent from the JSON response and `x-request-id` was absent from the headers |

The isolated local PostgreSQL database `observation_jev_live_20261030_216a64c6`, tenant `oakridge/jev-live-walkthrough`, retains subject occurrence `canonical-json/v1:1314f7fa5f25a135235031a0e1a07c18fbf17d06ed18da552820025f93ca17e3`, execution `ca807f29-e78e-462d-beb8-9b90dada4622` (`completed`), and grade observation `65e400ee-6fd7-412b-bc5d-9bca3c4b8809` (`answered`, `unsupported`). A separate read verified the execution and grade persisted. The account's actual response matches the [public TypeSafe OpenAPI contract](https://api.typesafe.ai/openapi.json): it documents `model`, `answers`, and `usage`, but neither `cost` nor `id`. The requirement for provider-reported cost and request ID needs a provider contract or account agreement that supplies them; this runner does not substitute an estimate or invented ID. Fastino GLiDE and the LLM judge remain configuration-gated.

### Direct Jev live brief grade (2026-10-30)

`observation/scripts/jev-live-walkthrough.ts` is the repeatable form of this walkthrough;
the plan grade above was performed by hand before it existed. It ingests the checked-in
run-slice revisions through the Oakridge source-event route, projects their criteria,
enqueues one `jev_direct` job and runs a single worker attempt. Run it with
`OAKRIDGE_TEST_DATABASE_URL` and `TYPESAFE_API_KEY` set:

```bash
bun scripts/jev-live-walkthrough.ts --question brief.source_fidelity
```

`--question plan.criterion_traceability` reproduces the plan half. The queue admits a
network grade only against a positive `estimated_cost`, which `--estimated-cost` sets and
which defaults to `0.01`; that reservation is what the spend caps charge, because TypeSafe
reports no cost of its own.

This completes the planning-and-brief pass: the brief half graded
`brief.source_fidelity/v1` on brief criterion `criterion-lineage` ("Trace a shared
criterion id") against the plan criterion it derives from ("Lineage is explicit"), both
supplied as `public` references with content. TypeSafe returned HTTP 200 with
`model: "jev-1.14.0"`, choice `changed_meaning`, confidence `0.61`, probabilities
`{faithful: 0.21, changed_meaning: 0.74, unclear_insufficient_evidence: 0.05}`, and usage
`{input_tokens: 524, output_tokens: 58}`. The same five execution fields were read back
from the stored row:

| Field | Stored value |
| --- | --- |
| Raw provider answer | `changed_meaning`, confidence `0.61`, and all three probabilities in `reproducibility_metadata.raw_answer` |
| Provider model version | `jev-1.14.0` in `reproducibility_metadata.provider_model` |
| Token usage | `input_tokens: 524`, `output_tokens: 58` in `model_usage` |
| Provider-reported cost | `null`; absent from the JSON response, so the attempt is charged the admitted `0.01` estimate |
| Provider request ID | `null`; `id` was absent from the JSON response and `x-request-id` was absent from the headers |

The local PostgreSQL database `observation_jev_live_20261030_cdffbb0f`, tenant
`oakridge/jev-live-walkthrough`, retains subject occurrence
`canonical-json/v1:a7af73b35f7b86f6484af0c648d4f018a4be20ff17521dd296888c59e3964b8c`,
execution `a36592fc-0193-48e1-ae93-a9ea8a454671` (`completed`) and grade observation
`0761f5cd-235a-4292-bd72-63bab9da8eb9` (`answered`, `changed_meaning`); its job reached
`terminal` in one attempt. Two runs of the same question returned `changed_meaning` both
times with confidence `0.66` and `0.61`, so the provider is not deterministic across
attempts and a repeat measurement needs its own attempt label. The cost and request ID
findings match the plan grade above: the account's responses still omit both, as the
public TypeSafe OpenAPI contract does.

Worker construction reads `TYPESAFE_API_KEY` and optional `TYPESAFE_BASE_URL` for Jev, or `FASTINO_API_KEY` and optional `FASTINO_BASE_URL` for GLiDE. Keys stay in the worker process. Set `OBSERVATION_EXTERNAL_PROCESSING_POLICY` to the selected provider processing agreement or policy identifier. Every provider attempt stores that value separately from local retention; if unset, the field is omitted.
# Historical source event repair

Use `bun observation/scripts/observation-repair.ts --through-txid <finite decimal txid> --namespace <namespace> --dry-run` to inspect a bounded authority range. Remove `--dry-run` to apply repair. The command requires `DBOS_SYSTEM_DATABASE_URL` and `OBSERVATION_DATABASE_URL`, serializes invocations for the namespace, and runs the production capture, projection, and grade writers without advancing the live source cursor or backfill checkpoint. Progress is persisted after each completed event; `--max-events N` stops after a bounded batch, and the next invocation resumes from its saved tuple. A completed range is rescanned on a later invocation so already accepted outcomes with missing derived rows can be repaired.

Dry run reads purge tombstones, existing source outcomes and captured revision identities to count known exclusions and conflicts. It labels derived-row conflicts as unchecked, because those require the production writers to compare existing rows during an actual repair.

### Restored-copy rehearsal (2026-11-01)

A temporary observation database was dumped with `pg_dump -Fc` and restored with `pg_restore` into a separate database. Its matching temporary authority history contained a launch and one draft revision publication, bounded at transaction ID `1714391`. The `rehearsal` tenant started with no captured source rows. The dry run inspected two events and left all counts, the cursor `(0, "")`, and the absent backfill checkpoint unchanged. Applying repair changed source revisions from 0 to 1; occurrences and grades stayed at 0 because the draft had no configured item selector. Conflicts, unresolved issues, and purge exclusions were each 0. The cursor remained `(0, "")`, and the backfill checkpoint remained absent. A second application inspected the same two events, inserted no rows, and left every count and position unchanged. This rehearsal verifies the restored-copy path on a bounded fixture; it does not claim to measure the full production history. A skipped-event count is not an expected count of new rows because an event may produce several rows or none.

An operator with a tenant-bound grade credential can explicitly resolve a run-mismatch issue through `POST /v1/sources/oakridge/issues/resolve` with `{ "issue_id": "...", "detail": "..." }`. The event is not projected by that resolution; the issue remains queryable as resolved.

Review the report's cursor before and after, source revision and derived row counts, conflicts, unresolved issue count, and purge exclusions. A skipped-event count is not an expected count of new rows: a source event may produce several rows or none. Query `/v1/sources/oakridge/issues` with the tenant's read credential for recorded and resolved source event issues, and `/v1/sources/oakridge/issue-health` for counts.
