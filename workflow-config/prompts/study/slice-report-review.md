# Review the slice

Check the report's criterion marks (`met` or `not_met`) and trigger marks (`fired` or `not_fired`) against the assessment and evidence.

- **Approve assessment** finalizes the assessment after proposals are disposed and assignments are resolved.
- **Correct the assessment** sends an authorized direct correction to the assessor.
- **Send selected feedback to builder** dispatches authorized assignments to the slice builder. The builder’s update goes back to the assessor for verification.
- **Expand** approves the reviewed report separately, after assessment approval and only when all triggers are `not_fired`. Expansion starts after the slice PR merges or you confirm the merge.

Use **Change design** to request a revision to the plan.

{{> shared/adjudication.md}}

## Plan

{{plan}}

## Slice build

{{slice_build}}

## Slice report

{{slice_report}}

## Slice assessment

{{slice_assessment}}
