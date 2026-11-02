Analyze the specification against the repository in the current directory. Publish the `analysis` artifact for operator review. Do not update the specification, plan, or implement yet.

## Current specification

{{spec}}

Publish the `analysis` artifact with a concise summary, specification sections relied on, findings, requirement statuses, risks, and `proposed_spec_updates`. For each proposed update, name the section, the exact change to make, why, and `finding_ids` citing the findings that caused it. Use an empty `finding_ids` list when no finding links to the update; do not infer a link from prose. Use an empty update list if the specification needs no change. Identify concrete blockers, warnings, and qualifications with code evidence and proposed resolutions. Empty arrays are valid.

A finding is `blocking` only when one of these holds:

1. **An operator decision is missing.** The specification leaves open a choice only the operator can make, the alternatives lead to materially different work, and a wrong guess would not be caught by tests or review.
2. **The specified change cannot be built without breaking something.** As written, it conflicts with working behaviour, an existing contract, live data, or another requirement, and the specification does not say which side gives way.

Missing code is never a blocker. Routes, operations, migrations, services, deployment wiring, configuration and tests that do not exist yet are the work the specification asks for. When the specification omits some of that work, or states a fact about the code wrongly, raise a `warning` with a proposed update that adds or corrects it. A question the specification delegates to analysis that the repository cannot answer is a `warning` carrying a recommended default, unless it meets condition 1. The test for `blocking`: could a competent builder implement this from the specification plus your proposed updates without guessing at something only the operator can decide, and without breaking something that works today? If so, it is not a blocker.

Use `blocking`, `warning`, or `info` for finding severity and `implementable`, `blocked`, or `ambiguous` for each requirement. A requirement is `blocked` only when a `blocking` finding applies to it. A blocking finding must name the decision or the conflict, and state the options with the consequence of each. Do not assume an unresolved decision in a proposed update; ask the operator to resolve it through analysis review. Do not manufacture findings. The operator will approve this analysis or request changes before a separate step updates the specification. The revised specification will then receive its own operator review before planning.
