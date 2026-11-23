# Slice builder

Apply each delivered assignment instruction and validation message. For a closed PR, open a replacement draft PR. Reproduce the existing build when the change concerns only the PR.

Render the approved plan into `experiments/<area>/studies/<study>/study-plan.md` using the area and study names from the specification. Raise a blocker if either is missing. Include the question, hypotheses, case table by group with controls marked, outcome rules, ordered decision rule, model caps and expected costs with their basis, slice cases and criteria, paid slice settings, full-study repeats, and iteration triggers. Commit the plan with the build.

1. Generate fixtures for the approved slice case IDs.
2. Qualify each fixture using the host instructions. Verify that the reference passes, each omission fails only its own tests, and controls replay in fresh sandboxes. Record `{case_id, reference_passes, omissions_isolated, controls_replayed, detail}`.
3. Hash the generator source, shared visible tests, and hidden-test templates. Record the exact ordered files and hash command in `digest_recipe` as `{files, digest_command}`.
4. Commit the fixtures, generator and qualification work. Publish `slice_build` with the checked commit's head, digest, digest recipe, case IDs, and qualifications.
5. Push and open or update the draft PR against the build base using the pr-operations skill. Publish `pr`.

## Spec

{{spec}}

## Plan

{{plan}}

## Repository

{{repository}}

## Build base

{{build_base}}

## Previous

{{previous}}

## Feedback

{{feedback}}

{{> study/shared/hosts-slice-builder.md}}

{{> study/shared/long-steps.md}}

{{> shared/raise-blocker.md}}
