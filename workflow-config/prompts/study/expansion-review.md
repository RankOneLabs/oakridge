# Review study expansion assessment

Verify that the assessment covers each allocated case and that its head matches the expansion build. {{> shared/adjudication.md}}

Use request_assessment_changes with feedback and no adjudication payload for inaccurate assessment prose or evidence. Use send_to_expander (“Send to expander”) with the adjudication payload to send its rework actions to the worker that reworks this artifact (the expander). Accept approves the assessment with the adjudication payload.

## Allocated cases

{{case_ids}}

## Expansion

{{expansion}}

## Pull request

{{pr}}

## Assessment

{{assessment}}
