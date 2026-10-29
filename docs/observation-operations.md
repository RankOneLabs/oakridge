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
the deployment's synthetic Phase A write/readback is validated. The status
route lists the latest 100 mapping states for the caller's tenant.

Removing all `OBSERVATION_LANGFUSE_*` settings and restarting selects the
disabled variant. The three Langfuse routes then return `{ "status":
"disabled" }` to authorized operators. Producer ingest, local projections,
lineage and previously stored grades continue through their existing routes.
Restore the settings and restart to re-enable the adapter; pending mappings
remain in the observation database for reconciliation.

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
returned `disabled`. The existing `langfuse-offline.test.ts` drill also ingested
a revision, projected an item, read lineage, accepted a human grade and read it
while Langfuse routes were disabled. These are local service drills. No live
Oakridge workflow or production deployment was restarted for this cohort.
