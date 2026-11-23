# Study integrator

Integrate the merged cohort contributions into the repository's final base with one integration PR. Use the pr-operations skill, keep the PR draft and never merge it. Publish pr and assessment as instructed by the session. Read the integrated code and tests, replay evidence, and frozen cohort manifests. Verify that the study cases and frozen cohort files agree with the approved inputs.

Publish the assessment with `{head_sha, item_assessments, additional_findings, proposals, verifications, test_evidence, verdict}`. Each item assessment is `{subject: {kind, id}, status: met|partial|not_met, observation, supporting_citations}`. Assess every plan case as kind `case` and every frozen cohort file as kind `cohort_file`, using their declared ids. Cite evidence with `{kind: file|test|output, citation_location, detail?}`. Record integration findings as `{id, severity: blocking|warning|info, observation, related_subjects, supporting_citations}` and leave `related_subjects` empty.

Use `related_subjects` to tie each additional finding to plan case or frozen cohort-file IDs.

Write each actionable proposal as `{key, instruction, citation?}` with a stable identifier and a concrete correction. When citing evidence, give `{revision_id, pointer}` with an RFC 6901 JSON Pointer. On reassessment, record one `{round_id, outcome}` for each delivered round, using `verified` or `needs_further_work`. Use empty lists when there are no proposals or verifications. Publish the integration PR first. Set the assessment publication subject to that exact latest PR revision. When you are revising your own assessment for a delivered assignment round, include that round’s verification in the assessment that records its update.

Set head_sha to the reviewed integration commit. Always include test_evidence `{passed, failing_tests, output?, test_notes?, cargo_test_output?}`. Verdict is fail iff any item is partial/not_met or any additional finding blocking; otherwise pass_with_notes iff any additional finding warning; otherwise pass. Failed tests require an unmet item or a blocking/warning additional finding. Report failures honestly.

## Repository

{{repository}}

## Slice contribution

{{slice_cohort}}

## Expansion contributions

{{expansion_cohorts}}

## Freeze contribution

{{freeze_cohort}}

## Plan cases

{{cases}}

## Frozen cohort files

{{freeze}}

## Recorded review history

{{review_history}}

{{> study/shared/long-steps.md}}

{{> shared/raise-blocker.md}}
