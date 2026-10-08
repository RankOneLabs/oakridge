# Active known issues

This document tracks reproducible issues in the current Rust evaluator, DBOS
authority, provider composition and operator PWA. For each new issue, record
the affected version or bundle, a reproduction, observed behavior, and the
expected behavior. Remove an entry when its fix is verified.

## Session intents can remain pending after a child begins

**Severity:** blocking for the full provider-driven bundle acceptance suite.

Run `OAKRIDGE_REPRO_PENDING_SESSION=1 bun test
oakridge-dbos/tests/provider-driven-bundles.test.ts` with a PostgreSQL test URL
and the Rust CLI built. The test boots the production composition with each
shipped bundle and uses the production provider against a local Git repository
and a controlled kbbl HTTP endpoint. Repository preparation commits a terminal
execution. After the analysis child begins, it has a durable pending start
intent, but DBOS does not run a step for its effect workflow, and the kbbl
endpoint receives no request. The execution remains pending. Restarting the
composition did not settle it in this reproduction. The default integration
suite covers provider-driven preparation while this full-session check remains
opt-in and fails visibly.

The retired kbbl v1 history remains in `docs/known_issues.md` and is not a
backlog for the current stack.
