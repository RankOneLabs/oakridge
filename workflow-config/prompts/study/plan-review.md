# Review study plan

Check the question and hypotheses against the specification. Check the cases and controls and verify that the groups partition the cases. Verify that the outcome rules are mechanical and the decision rule rows are ordered and complete. Check that costs are in cents and the stated cost basis is supported. Check the slice's risk reason and whether each slice criterion and iteration trigger is checkable. Accept the plan or request concrete changes.

## Study specification

{{spec}}

## Study plan

{{plan}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
