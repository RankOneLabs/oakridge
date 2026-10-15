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

