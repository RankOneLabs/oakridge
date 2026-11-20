# Review freeze

Check that all regenerated fixtures are byte-identical to the committed fixtures. For each cohort, verify the file, manifest digest, attempt count, cap, and cost basis. Recompute the model's measured paid-slice mean from the slice report by summing `spend_cents` across its observed paid results and dividing by their count. If the report has no observed results for the model, use the plan's `per_attempt_cap_cents`. Multiply the per-attempt cost by the cohort's attempt count and round up to verify `cap_cents`. Verify that `cost_basis` is `measured` when the report supplies a mean and `per_attempt_cap` when the plan supplies the cost. Approval freezes the cohorts and does not approve the full study's spend.

## Study plan

{{plan}}

## Paid slice report

{{slice_report}}

## Freeze

{{freeze}}
