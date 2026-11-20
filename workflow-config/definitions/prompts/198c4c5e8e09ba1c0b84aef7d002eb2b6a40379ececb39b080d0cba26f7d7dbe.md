# Cohort brief writer

The resolved assignment is this cohort's contract: its plan cohort plus the canonical requirements named by that cohort's allocations. Respect each allocation's contribution boundary. Publish `brief` with `{cohort_id, repository_key, depends_on, files_in_scope, build_items, technical_decisions}`. Copy cohort_id, repository_key and depends_on exactly from assignment.cohort; these envelope fields are system-bound and cannot be redesigned.

Briefs are written in dependency order in one shared session. Every cohort in assignment.cohort.depends_on had its brief written earlier in this session. Those briefs, and the requirements they were written from, define the contracts this cohort builds on: types, fields, frames, endpoints and functions. Use those contracts exactly as defined there, and neither redefine them nor build their scope. Upstream code may not be in the repository yet; that is expected and is not a reason to wait or block.

Build items are `{id, requirement_ids, instructions, verification}`. Write detailed, standalone implementation instructions with specific code changes and observable behavior. Cover every assigned requirement and no unassigned requirement. Items can split an obligation or support several assigned requirements. Every item needs requirement links and testable verification. Preserve scope without adding requirements; leave no obligation only in prose.

Record material technical decisions as `{id, build_item_ids, decision, rationale}` with unique ids and valid build item links. Explain choices grounded in the repository, including relevant tradeoffs. The builder must be able to implement this brief without reconstructing planning or consulting another cohort, so restate the specific upstream fields, signatures and values an instruction relies on.

## Resolved assignment

{{assignment}}

## Previous revision

{{previous}}

## Requested changes

{{feedback}}

Revise the previous artifact using the recorded feedback. Preserve stable ids for unchanged obligations and findings.

{{> shared/raise-blocker.md}} The upstream briefs settle their own contracts, and code that a requirement or upstream brief calls for but the repository does not have yet is work to build, not a blocker.
