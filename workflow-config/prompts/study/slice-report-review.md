# Review slice report

Read the assessment's findings and the report's criterion and trigger marks first. Choose one of these decisions.

- **Expand** (approve). The generator digest in the slice build becomes fixed for every expansion unit, and expansion starts.
- **Send to builder** (request changes on the slice build). The builder fixes fixtures or tests and qualifies the slice again. Any rebuild resets paid validation. A new spend request needs your approval before another paid run.
- **Change design** (request changes on the plan). The designer revises the plan. After you approve it, the whole slice runs again, including a new spend request and a new paid run.

## Study plan

{{plan}}

## Slice build

{{slice_build}}

## Paid slice report

{{slice_report}}

## Slice assessment

{{slice_assessment}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
