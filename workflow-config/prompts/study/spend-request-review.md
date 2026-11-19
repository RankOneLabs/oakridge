# Review spend request

Check the cohort file and verify that its attempt count is the number of paid slice models × repeats × slice cases. Check that the cap is within `slice_paid.cap_cents` and that the generator digest and case IDs exactly match the slice build. Approving starts the paid run on otto. Requesting changes sends the request back to the builder.

## Study plan

{{plan}}

## Slice build

{{slice_build}}

## Spend request

{{spend_request}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
