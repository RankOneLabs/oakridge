# Review integration assessment

Check evidence-backed coverage, accurate statuses, regression findings, linked actions, audience routing and the validated verdict/test rules. For every proposed next action record a durable disposition in `entries`: `{action_id, disposition: accepted|modified|rejected, original_text, final_text?, audience: builder|operator, source: {kind: item_assessment|additional_finding, id}, reason?}`. Preserve the action id and original text; modified actions need final_text, rejected actions need a reason. Record operator additions in `added_actions`: `{action_id, origin: operator, final_text, audience, source, reason?}`. Keep operator prerequisites separate from builder corrections. Reconcile previous dispositions; a rejected recommendation needs new evidence to return.

Adjudication is `{entries, added_actions, builder_feedback}`. Include only concrete corrections for the builder/integrator in builder_feedback; only that field is forwarded. All dispositions remain durable review history. Accept requires this payload, even with empty entries/actions. Do not accept while validation has failed.

Judge every distinct canonical requirement once across cohort contributions, with no missing or unknown requirements. Verify integration regressions and combined behavior against the specification. Use request_changes with the adjudication payload to send corrections to the integrator; accept also carries the adjudication payload.

## Repository

{{repository}}

## Completed cohorts

{{cohorts}}

## Applicable briefs

{{briefs}}

## Canonical requirements

{{requirements}}

## Assessment

{{assessment}}

## Pull request

{{pr}}

## Observed PR state

{{pr_state}}
