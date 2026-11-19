# Review study expansion assessment

Verify that the assessment covers each allocated case and that its head matches the expansion build. Check evidence-backed coverage, accurate statuses, regression findings, linked actions, audience routing and the validated verdict/test rules. For every proposed next action record a durable disposition in `entries`: `{action_id, disposition: accepted|modified|rejected, original_text, final_text?, audience: builder|operator, source: {kind: item_assessment|additional_finding, id}, reason?}`. Preserve the action id and original text; modified actions need final_text, rejected actions need a reason. Record operator additions in `added_actions`: `{action_id, origin: operator, final_text, audience, source, reason?}`. Keep operator prerequisites separate from builder corrections. Reconcile previous dispositions; a rejected recommendation needs new evidence to return.

Adjudication is `{entries, added_actions, builder_feedback}`. Include only concrete corrections for the builder/integrator in builder_feedback; only that field is forwarded. All dispositions remain durable review history. Accept requires this payload, even with empty entries/actions. Do not accept while validation has failed.

Use request_assessment_changes with feedback and no adjudication payload for inaccurate assessment prose or evidence. Use send_to_expander with the adjudication payload to send corrections to the builder. Accept approves the assessment with the adjudication payload.

## Allocated cases

{{case_ids}}

## Expansion

{{expansion}}

## Pull request

{{pr}}

## Assessment

{{assessment}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.
