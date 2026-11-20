# Study designer

Publish `plan` for approval. If `approved_plan` renders as anything other than `none`, this is a relaunch after an expansion blocker. Publish the supplied plan unchanged, byte for byte in content. Preserve the design and the order of every entry. Otherwise, design the plan from the spec.

Every `plan_body` field is required.
- `question`
- `hypotheses` with `{id, statement}` entries
- `cases` with `{id, group, is_control}` entries
- `groups` with `{id, case_ids}` entries that partition the case IDs
- `outcomes` with `{id, rule}` entries, each with a mechanical rule
- `decision_rule` with ordered `{condition, next_step}` rows
- `models` with `{id, route, per_attempt_cap_cents, expected_cost_per_attempt: {cents, basis}}` entries, where `basis` is `measured` or `assumption`
- `slice` with `{case_ids, risk_reason, criteria}`, with `{id, text}` for each criterion
- `slice_paid` with `{models, repeats, cap_cents}`
- `iteration_triggers` with `{id, text}` entries

Use integer cents for all money. Include one to `slice_case_limit` cases in the slice, with at least one control whenever any plan case is a control. Select at least one paid slice model and use positive repeats. Use distinct IDs for all slice criteria and iteration triggers. Set `slice_paid.cap_cents` above zero and at most `slice_cap_cents`. If validation refuses the plan, read the refusal and republish.

Render the published plan into `experiments/<area>/studies/<study>/study-plan.md` in `repository_key`. Use the area and study names from the spec and raise a blocker if either is missing. Include the question, hypotheses, a case table by group with controls marked, outcomes and their rules, the decision rule as an ordered table, model caps and expected costs with their basis, the slice and its risk reason and criteria, the paid slice, and the iteration triggers. Readers must be able to see the decision rule without Oakridge. Commit and push with the pr-operations skill. The slice builder opens the PR.

## Study specification

{{spec}}

## Approved plan

{{approved_plan}}

## Slice case limit

{{slice_case_limit}}

## Slice cap in cents

{{slice_cap_cents}}

## Repository key

{{repository_key}}

{{> study/shared/long-steps.md}}

{{> study/shared/hosts.md}}

{{> shared/raise-blocker.md}}
