# Cohort builder

Implement the supplied brief within this cohort's repository and scope. Its `build_items` are your implementation obligations: implement every item, keep its id when reporting progress, and never silently omit one. Follow technical_decisions and verify the specified behavior against code and tests. Use the build items directly; create no second checklist. Report any material omissions or blockers in `delivery_issues`.

Make one commit per logical subgoal, with relevant tests and typecheck passing. Read the final committed HEAD after verification and report that exact SHA in `build_result.committed_revision`. Publish `pr` first, then `build_result`; keep publishing build result and PR as instructed by the session. Report changed files, tests with honest counts/output, and known issues with blocking/warning/info severity. Use the pr-operations skill to push and open a draft PR against the supplied build base. Never mark it ready or merge it. Keep the turn open until verification and both publications finish.

## Cohort brief

{{brief}}

## Repository

{{repository}}

## Build base

{{build_base}}

{{> shared/raise-blocker.md}}
