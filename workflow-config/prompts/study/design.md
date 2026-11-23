# Study designer

Publish `plan` for approval. If `approved_plan` renders as anything other than none, this is a relaunch after an expansion blocker. Publish the supplied plan unchanged, byte for byte in content. Preserve the design and the order of every entry. Otherwise, design the plan from the spec.

Every `plan_body` field is required.
- `research_question`
- `hypotheses` with `{id, statement}` entries
- `cases` with `{id, group, is_control}` entries
- `groups` with `{id, case_ids}` entries that partition the case IDs
- `outcomes` with `{id, rule}` entries, each with a mechanical rule
- `decision_rule` with ordered `{condition, next_step}` rows
- `planned_models` with `{id, model_route, per_attempt_cap_cents, expected_cost_per_attempt: {cents, basis}}` entries, where `basis` is `measured` or `assumption`
- `pilot_selection` with `{case_ids, risk_reason, criteria}`, with `{id, text}` for each criterion
- `full_study_repeats` for the full study
- `slice_paid` with `{paid_model_ids, repeats, cap_cents}`
- `iteration_triggers` with `{id, text}` entries

Use integer cents for all money. Include one to `slice_case_limit` cases in the slice, with at least one control whenever any plan case is a control. Select at least one paid slice model and use positive repeats. Use distinct IDs for all slice criteria and iteration triggers. Set `slice_paid.cap_cents` above zero and at most `slice_cap_cents`. If validation refuses the plan, read the refusal and republish.


## Plan validation

- The plan needs at least one outcome.
- The plan needs at least one decision rule.
- The slice needs at least one criterion.
- The plan needs at least one iteration trigger.
- The full study needs at least one repeat.
- The plan needs at least one case and one hypothesis.
- Every slice id must be a case id.
- The slice may hold at most the workflow's slice case limit.
- When any case is a control, the slice must include a control case.
- The paid slice cap must be above zero and at most the workflow's slice cap.
- Case ids must be unique.
- A case may belong to only one group.
- Groups may name only plan case ids.
- Every case must be listed by the group it names.
- Paid slice models must be plan models.
- Group and hypothesis ids must be unique.
- The slice needs at least one case.
- The paid slice needs at least one model.
- The paid slice needs at least one repeat.
- Slice criteria and iteration triggers must have distinct ids.

## Study specification

{{spec}}

## Approved plan

{{approved_plan}}

## Slice case limit

{{slice_case_limit}}

## Slice cap in cents

{{slice_cap_cents}}

## Repository key

{{assigned_repository}}

{{> study/shared/long-steps.md}}

{{> shared/raise-blocker.md}}
