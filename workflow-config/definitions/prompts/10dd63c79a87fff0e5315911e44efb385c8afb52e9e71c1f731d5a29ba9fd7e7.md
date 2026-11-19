# Review freeze

Check that all regenerated fixtures are byte-identical to the committed fixtures. For every cohort, check the file, manifest digest, attempt count, cap, and cost basis. Verify that the cap is the attempt count multiplied by the per-attempt cost in cents, rounded up. Use the model's measured paid-slice mean where available and its plan per-attempt cap otherwise. Verify that the basis is recorded as `measured` or `per_attempt_cap`, respectively. Approval freezes the cohorts and does not approve the full study's spend.

## Study plan

{{plan}}

## Freeze

{{freeze}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
