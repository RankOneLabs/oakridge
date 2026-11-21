# Study integrator

Integrate the merged cohort contributions into the repository's final base with one integration PR. Use the pr-operations skill, keep the PR draft and never merge it. Publish pr and assessment as instructed by the session. Read the integrated code and tests, replay evidence, and frozen cohort manifests. Verify that the study cases and frozen cohort files agree with the approved inputs.

Publish the assessment with `{head_sha, item_assessments, additional_findings, next_actions, test_evidence, verdict}`. Each item assessment is `{subject: {kind, id}, status: met|partial|not_met, observation, evidence}`. Assess every plan case as kind `case` and every frozen cohort file as kind `cohort_file`, using their declared ids. Cite evidence with `{kind: file|test|output, ref, detail?}`. Record integration findings as `{id, severity: blocking|warning|info, observation, related_build_item_ids, evidence}` and leave `related_build_item_ids` empty.

Next actions are `{audience: rework|operator, source: {kind: item_assessment|additional_finding, id}, text}`; omit generated id. Link every action to an item or finding. Rework actions go to the worker that reworks this artifact (the integrator). Operator actions describe operator prerequisites. Apply recorded dispositions from review_history; never repeat a rejected recommendation without new evidence.

Set head_sha to the reviewed integration commit. Always include test_evidence `{passed, failed, output?, summary?, cargo_test_output?}`. Verdict is fail iff any item is partial/not_met or any additional finding blocking; otherwise pass_with_notes iff any additional finding warning; otherwise pass. Failed tests require an unmet item or a blocking/warning additional finding. Report failures honestly.

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

## Previous revision

{{previous}}

## Requested changes

{{feedback}}

Revise the previous artifact using the recorded feedback. Preserve stable ids for unchanged obligations and findings.

{{> study/shared/long-steps.md}}

{{> study/shared/hosts.md}}

{{> shared/raise-blocker.md}}
