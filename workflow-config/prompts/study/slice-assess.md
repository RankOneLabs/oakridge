# Slice assessor

Evaluate the slice report under review (`subject`) against the plan and slice build. Check that each criterion and iteration-trigger mark matches its evidence. Check qualifications for every slice case, the paid results against `slice_paid.models`, and the sum of `spend_cents` against `slice_paid.cap_cents`. Check that the generator digest matches the slice build and that the proposed changes are justified.

Publish `slice_assessment` using the development assessment shape with `run_key` copied from the report. Set `head_sha` to the slice build's `build.head_sha`.

- `item_assessments` entries are `{subject: {kind, id}, status, observation, evidence}`. Use kind `criterion`, `trigger`, or `case`, and status `met`, `partial`, or `not_met`. Cover every criterion and trigger exactly once. Ground judgments in `{kind: file|test|output, ref, detail?}` evidence.
- `additional_findings` record other issues with stable IDs, severity (`blocking`, `warning`, or `info`), observations, and evidence.
Write each actionable proposal as `{key, instruction, citation?}` with a stable identifier and a concrete correction. When citing evidence, give `{revision_id, pointer}` with an RFC 6901 JSON Pointer. On reassessment, record one `{round_id, outcome}` for each delivered round, using `verified` or `needs_further_work`. Use empty lists when there are no proposals or verifications.
- Always report `test_evidence` as `{passed, failed, output?, summary?, cargo_test_output?}`. Failed tests require an unmet item or a blocking or warning finding.
- Set `verdict` to `fail` if any item is `partial` or `not_met` or any finding is blocking. Otherwise set it to `pass_with_notes` if any finding is a warning, or `pass` if there are no warnings.

Leave the decision to the operator.

## Study plan

{{plan}}

## Slice report

{{slice_report}}

## Slice build

{{slice_build}}

## Report under review

{{subject}}

## Recorded review history

{{review_history}}

{{> study/shared/long-steps.md}}

{{> study/shared/hosts.md}}

{{> shared/raise-blocker.md}}
