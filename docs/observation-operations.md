# Observation operations

The observation service stores its own PostgreSQL data. Oakridge remains the
workflow authority. Start the service with `OBSERVATION_DATABASE_URL` and
`bun run --filter observation start`; it binds to `127.0.0.1:8791` unless
`OBSERVATION_HOST` or `OBSERVATION_PORT` is set. `scripts/oakridge-start` starts
it alongside DBOS and kbbl only when `OBSERVATION_DATABASE_URL` is nonempty.
For an independent Springfield deployment, run the same package with its own
database, credentials and network binding, then point the Oakridge publisher
at its URL. That deployment topology is documented here, not automated.

## Producer ingest credential and scope

Configure `OBSERVATION_INGEST_CREDENTIALS` as a JSON array of
`{"producer":"oakridge","namespace":"development","token":"<secret>"}`
entries. Give DBOS the matching `OAKRIDGE_OBSERVATION_NAMESPACE`,
`OAKRIDGE_OBSERVATION_INGEST_TOKEN`, and `OAKRIDGE_OBSERVATION_URL` (for a local
`oakridge-start` service, `http://127.0.0.1:${OBSERVATION_PORT:-8791}`). DBOS
does not construct the publisher when the URL is absent. The start script does
not set that publisher URL automatically. An ingest token may
only submit and inspect its configured producer and namespace through the
source routes; it cannot read item history, grade, or export. Configure
separate tenant-bound arrays `OBSERVATION_READ_CREDENTIALS`,
`OBSERVATION_GRADE_CREDENTIALS`, and `OBSERVATION_EXPORT_RAW_CREDENTIALS` for
those capabilities. Tokens must be unique across all four arrays. Keep them in
the runtime secret store, outside checked-in configuration and logs. Credentials
are configuration-sourced; rotation means replacing the configuration and
restarting the service and publisher together.

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
