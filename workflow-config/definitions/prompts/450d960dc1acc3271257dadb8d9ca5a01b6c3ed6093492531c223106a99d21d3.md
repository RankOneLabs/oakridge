# Review freeze

Check that all regenerated fixtures are byte-identical to the committed fixtures. For each cohort, verify the file, manifest digest, attempt count, cap, and cost basis. Recompute the model's measured paid-slice mean from the slice report by summing `spend_cents` across its observed paid results and dividing by their count. If the report has no observed results for the model, use the plan's `per_attempt_cap_cents`. Multiply the per-attempt cost by the cohort's attempt count and round up to verify `cap_cents`. Verify that `cost_basis` is `measured` when the report supplies a mean and `per_attempt_cap` when the plan supplies the cost. Approval freezes the cohorts and does not approve the full study's spend.

## Study plan

{{plan}}

## Paid slice report

{{slice_report}}

## Freeze

{{freeze}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
