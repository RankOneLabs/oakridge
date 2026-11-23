# Revise freeze

Apply the feedback to the previous freeze and republish after repeating the verification below.

Regenerate all cases from the approved generator using the host instructions below. Reproduce `generator_digest` using the files and hash command in `digest_recipe`. Compare the regenerated fixtures with the committed slice and expansion fixtures byte for byte. Set `is_byte_identical` to reflect the comparison and raise a blocker if anything differs.

Freeze the cohort files with their manifest digests and the pinned evaluator image digest. List `case_ids` and `groups` for each cohort. Use an empty group list for cross-group cohorts and ensure every plan case and group is covered. Compute `attempt_count` as models × full-study repeats × this cohort’s cases. Use unique cohort IDs that are distinct from all plan case IDs. Compute `cap_cents = ceil(attempt_count × per-attempt cost in cents)` for each cohort, rounding up after multiplication. Use the measured paid-slice mean for the cohort's model when the slice measured it: sum `spend_cents` over that model's observed paid results and divide by their count. Otherwise use the model's `per_attempt_cap_cents` from the plan. Record `cost_basis` as `measured` or `per_attempt_cap`, respectively.

Commit the frozen cohorts and publish `freeze` as `{build: {cohort_id: "freeze", title, head_sha, change_overview, changed_files}, generator_digest, image_digest, is_byte_identical, cohorts: [{id, manifest_path, digest, case_ids, groups, attempt_count, cap_cents, cost_basis}]}`. Use the pr-operations skill to push and open or update the draft PR against `build_base`, then publish `pr`.

Approving the freeze does not authorize the full study's spend.

## Study plan

{{plan}}

## Approved generator digest

{{generator_digest}}

## Digest recipe

{{digest_recipe}}

## Paid slice report

{{slice_report}}

## Expansion results

{{expansions}}

## Repository

{{repository}}

## Build base

{{build_base}}

## Previous artifact

{{previous}}

## Feedback

{{feedback}}

{{> study/shared/long-steps.md}}

{{> study/shared/hosts-freezer.md}}

{{> shared/raise-blocker.md}}
