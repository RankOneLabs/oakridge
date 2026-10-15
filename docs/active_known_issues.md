# Active known issues

This document tracks reproducible issues in the current Rust evaluator, DBOS
authority, provider composition and operator PWA. For each new issue, record
the affected version or bundle, a reproduction, observed behavior, and the
expected behavior. Remove an entry when its fix is verified.

## Lost run wake (oakridge-dbos, current authority)

Reproduction: let the run workflow finish an advance and begin dispatching a
carrier, then have that carrier commit work and call `wakeRun` before the run
workflow enters `DBOS.recv(RUN_WAKE_TOPIC)`. Observe the next advance with a
long wake timeout.

Observed during verification: the pinned DBOS SDK inserts the wake into its
durable notifications table before `recv`; the run consumes it after dispatch
and advances before the timeout. The suspected lost wake could not be
reproduced at this timing. Expected: a wake during dispatch remains pending
and the run advances promptly after dispatch, without waiting for the timeout.

## pr_watch ends on a transient forge outage (oakridge-dbos, current authority)

Reproduction: run `pull_request.observe` as a periodic code worker and make
the forge unavailable through its start-attempt retry budget. Restore the
forge with the pull request merged.

Observed: `carryCode` records a failed attempt and settles the watch as
failed, so it never observes the merge. Expected: an unavailable operation
ends that attempt but keeps the watch alive, retries with backoff and observes
the merge; a terminal operation failure or a stop still settles the watch.

## Timestamp cursor loses microseconds (oakridge-dbos, current authority)

Reproduction: place two history events, or two runs, inside one millisecond
with different PostgreSQL microseconds. Page with limit one through the HTTP
read model, following `next_cursor` each time.

Observed: the cursor encodes `Date.toISOString()`, which truncates the
PostgreSQL timestamp to milliseconds; the `(created_at, id)` comparison can
repeat or skip a row. The runs cursor uses the same encoding and is affected.
Expected: both cursors retain the full PostgreSQL timestamp while preserving
the tuple comparison and return each item exactly once.

## Deadlock classified as serialization failure (oakridge-dbos, current authority)

Reproduction: make `commit_event`'s database transaction fail with SQLSTATE
`40P01`, then with `40001`, and inspect the conflict detail returned to the
caller.

Observed: both return the same generic `database concurrency conflict` reason.
Expected: both remain retryable conflicts, with a distinct recorded reason
that names deadlock detection or serialization failure respectively.
