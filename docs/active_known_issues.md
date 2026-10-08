# Active known issues

This document tracks reproducible issues in the current Rust evaluator, DBOS
authority, provider composition and operator PWA. For each new issue, record
the affected version or bundle, a reproduction, observed behavior, and the
expected behavior. Remove an entry when its fix is verified.

The retired kbbl v1 history remains in `docs/known_issues.md` and is not a
backlog for the current stack.

## Open issues

None.

Every shipped bundle is driven to a committed terminal state, fully
provider-driven through the production composition, by
`oakridge-dbos/tests/provider-driven-bundles.test.ts`, with mid-run process
recovery covered by `oakridge-dbos/tests/provider-driven-recovery.test.ts`.

## Writing a kbbl stand-in

Two details of kbbl's wire contract are easy to get wrong in a test double,
and getting either wrong looks exactly like "the session never becomes
terminal" rather than like a broken double:

- `PUT /sessions/resumable/:sessionKey` takes a *session key* and answers with
  kbbl's own generated `sid`. They are different identifiers, and
  `GET /sessions/resumable/:sid/terminal` validates its segment against
  `SID_PATTERN` (a v4 UUID), which no session key matches.
- Hono decodes path params. A double that splits `URL.pathname` without
  decoding stores a key containing `:` under `%3A` and then looks it up under
  `%253A`.

`oakridge-dbos/tests/kbbl-stub.ts` keeps both behaviours and is the stand-in to
reuse rather than writing another.
