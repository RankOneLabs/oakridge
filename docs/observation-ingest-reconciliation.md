# Observation ingest reconciliation

## Service-held resume cursor and acknowledgement

The observation service persists one cursor per `(producer, namespace)` in
`observation.source_event_cursor`. It starts at `(0, "")`. Oakridge reads that cursor
with its scoped ingest credential, then scans `authority.event` after it in
`(commit_txid, id)` order. The scan admits only rows satisfying
`commit_txid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`, so a
transaction that acquired an earlier id but has not committed cannot be passed.
The observation service writes an event outcome and advances the cursor in one
transaction, then acknowledges the new cursor. A stale `previous` cursor gets a
conflict response; Oakridge reads the service cursor again.

## Replay after failure

After startup or any delivery failure, the adapter asks the service for its
cursor and re-reads Oakridge from that point. There is no resend buffer. If the
service committed a delivery but its acknowledgement was lost, its cursor
already advanced and the adapter starts after that event. If it did not commit,
the cursor stands and the event is read again. Oakridge writes no observation
cursor into `authority`.

## Historical labels and collaboration backfill

`bun run --filter oakridge-dbos ops -- observation-backfill <max_rows>` is an operator-triggered pass over the two sources absent from `authority.event`: historical `authority.review_decision` rows, then `authority.collaboration_thread` with their messages. The command processes at most `max_rows` source rows (1–1000) per invocation. The observation service durably records the `(created_at, id)` position and separate active/archived counts after every acknowledged row; the next invocation resumes it. The optional `position-json` argument starts an explicit replay range. A replay does not move the durable position.

The pass reads `authority.run` directly, so archived runs are included. It uses the same Oakridge mapping module and scoped ingest credential as live delivery. Review decisions retain their original timestamp, payload, review, decision and effect. Collaboration anchors resolve by exact JSON pointer within the named revision; an unmatched pointer records a queryable issue and leaves its comments unattached. Run the live revision tail before backfilling labels whose target revisions have not yet been captured. Historical and live decisions use the same source event ID and deterministic L2 identities, so replaying a range or overlapping the live cursor does not multiply rows.

## Mapping and unmapped outcomes

`oakridge-dbos/src/adapters/observation-mapping.ts` is the sole Oakridge-to-
observation translation. It maps `revision_published` to an artifact revision,
`operator_decided` to a human grade observation (including unit, review,
decision, target and feedback), and `launched` to run input background.
Human decisions are also stored as rows in `observation.source_human_grade`
with `evaluator_kind = 'human'` and can be read through the scoped
`GET /v1/sources/oakridge/human-grades` route.
`worker_started`, `worker_ended`, `retry_requested` and `cancel_requested` are
deliberately recorded as ignored outcomes. A new event variant or an artifact
kind absent from the pinned bundle's stage declaration becomes an `unmapped`
outcome, retaining event kind, run, event id and reason. The service stores
these in `observation.source_event_outcome` and exposes them through the scoped
`GET /v1/sources/oakridge/unmapped` read route. Its cursor advances only when
that row commits, so the tail continues past a visible gap.

## Artifact schema and body digests

The adapter resolves the bundle pinned to each run. A revision's schema
version hashes only that artifact kind's parsed declaration subtree in
`checked_program`; prompt-only changes leave this version stable. Each revision
also carries the bundle id and digest. Every source-event outcome carries its
wire format, pinned bundle identity and an artifact schema version when it
addresses an artifact. A launch additionally carries the digest of the run
input declaration. The body digest covers the body in
`authority.event.payload`, which is the body actually delivered. Oakridge does
not reuse `authority.ingress_receipt.request_digest`: it covers the whole
commit request rather than the body, is exposed by no route, and is deleted
with the run.

## Observed failure drills

`oakridge-dbos/tests/observation-publisher.test.ts` commits a launch, worker
start, artifact revision, worker end, human review and cancellation through the
real Oakridge commit path. After an adapter restart, the next delivery begins
at the service-held cursor. Reopening the Oakridge database handle mid-tail
simulates the read state after an `oakridge-dbos` restart and likewise starts
from the service cursor. `oakridge-dbos/tests/observation-process-restart.test.ts`
also stops and restarts the actual `oakridge-dbos` process between commits and
compares the service-delivered id set with every committed event id. During an
observation outage spanning a new adapter
instance, a delivery fails while Oakridge still commits a cancellation. The
service cursor remains at its previous event; when the service returns, the
adapter reads the cancellation and the delivered event-id set equals the
committed set, with one stored artifact revision and the human feedback intact.
The drill also inserts an unknown variant and a publication naming an absent
artifact declaration into `authority.event`; both become queryable unmapped
outcomes and the cursor passes them after acknowledgement.
`oakridge-dbos/tests/observation-event-order.test.ts` holds a lower transaction
id open past a higher commit: neither row is read until the older transaction
finishes, and each is then read once in cursor order. The publisher drill
repeats that ordering with the live publisher and confirms the service records
both events exactly once.

The development end-to-end test configures a URL that refuses observation
connections while Oakridge launches, publishes artifacts, accepts reviews and
completes its run. With `OAKRIDGE_OBSERVATION_URL` unset, the publisher is not
constructed at all. When set, `OAKRIDGE_OBSERVATION_NAMESPACE` and
`OAKRIDGE_OBSERVATION_INGEST_TOKEN` provide the producer's tenant scope and
ingest credential.
