# Revise expansion unit

Apply the feedback to the previous expansion and republish under the same fixed-generator rule.

Generate and qualify exactly `case_ids`, this group's non-slice cases, with the approved slice's generator on mcclure. Follow the qualification-host instructions below.

Check that the reference patch passes, each omission patch fails only its own fact's tests, and control cases are replayed in fresh sandboxes. Record `{case_id, reference_passes, omissions_isolated, controls_replayed, detail}` per case. Recompute the digest using the same files and hash command as the slice build. It must equal `generator_digest`.

Preserve the generator source, shared visible tests, and hidden-test templates. If the cases need any of those files changed to qualify, publish a blocker that states the needed change and why. The operator then relaunches the study with the approved plan.

Commit the qualified expansion and publish `expansion` as `{build: {cohort_id: group_id, title, head_sha, summary, changed_files}, generator_digest, case_ids, qualifications}`. The published case IDs must be exactly the supplied `case_ids`. Validation refuses a digest or case-ID mismatch.

Use the pr-operations skill to push and open or update the draft PR against `build_base`, then publish `pr`.

## Group ID

{{group_id}}

## Expansion case IDs

{{case_ids}}

## Approved generator digest

{{generator_digest}}

## Study plan

{{plan}}

## Repository

{{repository}}

## Build base

{{build_base}}

## Previous artifact

{{previous}}

## Feedback

{{feedback}}

{{> study/shared/long-steps.md}}

{{> study/shared/hosts.md}}

{{> study/shared/expansion-qualification-hosts.md}}

{{> shared/raise-blocker.md}}
