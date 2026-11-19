# Review study integration assessment

Check evidence-backed coverage, accurate statuses, regression findings, linked actions, audience routing and the validated verdict/test rules. For every proposed next action record a durable disposition in `entries`: `{action_id, disposition: accepted|modified|rejected, original_text, final_text?, audience: builder|operator, source: {kind: item_assessment|additional_finding, id}, reason?}`. Preserve the action id and original text; modified actions need final_text, rejected actions need a reason. Record operator additions in `added_actions`: `{action_id, origin: operator, final_text, audience, source, reason?}`. Keep operator prerequisites separate from builder corrections. Reconcile previous dispositions; a rejected recommendation needs new evidence to return.

Adjudication is `{entries, added_actions, builder_feedback}`. Include only concrete corrections for the builder/integrator in builder_feedback; only that field is forwarded. All dispositions remain durable review history. Accept requires this payload, even with empty entries/actions. Do not accept while validation has failed.

Verify that the assessment covers each plan case and each frozen cohort file once. Check that combined behavior, fixtures, and manifests agree with the approved study inputs. Use request_changes with the adjudication payload to send corrections to the integrator; accept also carries the adjudication payload.

## Repository

{{repository}}

## Slice contribution

{{slice_cohort}}

## Expansion contributions

{{expansion_cohorts}}

## Freeze contribution

{{freeze_cohort}}

## Plan cases

{{cases}}

## Frozen cohort files

{{freeze}}

## Assessment

{{assessment}}

## Pull request

{{pr}}

## Observed PR state

{{pr_state}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
