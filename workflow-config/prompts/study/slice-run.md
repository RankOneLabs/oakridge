# Run the approved paid slice

Use the approved request's cohort file, digest, case IDs, attempt count, and cap. Use the execution key `{{execution_key}}` and the claim and evidence endpoints in the task's execution block. Call claim before launching, with a fresh request ID.

- On launch, submit the cohort once with the execution key. Post evidence immediately upon acceptance with external ID, store path, and detail.
- On resume, use the attached evidence to reconstruct the report from the existing execution.
- On recover, look up the key and post the recovered evidence. Resubmit with the same key only when the backend guarantees deduplication by key.
- On reconcile_required, end the attempt and leave the launch to operator reconciliation.

A timeout or missing report never authorizes a new launch. Apply report corrections to the same execution.

Publish `slice_report` with the execution key as `run_key`, the build's digest and qualifications, observed `paid_results`, `criteria_marks`, `trigger_marks`, and `proposed_changes`. Each paid result has `{model_id, case_id, outcome, detail, spend_cents, launch_command, store_path}`; record limit-stopped attempts as `stopped`. Keep within the approved attempt count and cap. Mark each criterion `met` or `not_met` and each trigger `fired` or `not_fired`, with `mark_reason` for each mark.

## Plan

{{plan}}

## Spend request

{{spend_request}}

## Slice build

{{slice_build}}

## Repository

{{repository}}

{{> study/shared/hosts-slice-runner.md}}

{{> study/shared/long-steps.md}}

{{> shared/raise-blocker.md}}
