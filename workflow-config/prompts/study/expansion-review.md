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
