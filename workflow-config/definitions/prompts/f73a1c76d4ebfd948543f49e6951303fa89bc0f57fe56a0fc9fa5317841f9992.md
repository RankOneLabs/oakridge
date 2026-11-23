# Prepare slice spend request

Write the paid slice cohort file for the qualified build and publish `spend_request` as `{cohort_file, attempt_count, cap_cents, generator_digest, case_ids}`. Copy the build digest and case IDs exactly. Multiply the number of paid slice models by paid slice repeats and the number of slice cases for the attempt count. Keep the cap positive and within the plan's paid slice cap. Give the runner a cohort file it can retrieve from the authorized checkout.

## Plan

{{plan}}

## Slice build

{{slice_build}}

## Repository

{{repository}}

{{> study/shared/long-steps.md}}

{{> shared/raise-blocker.md}}
