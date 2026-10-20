Analyze the specification against the prepared repositories. Publish the `analysis` artifact for operator review. Do not update the specification, plan, or implement yet.

## Current specification

{{spec}}

## Repositories

{{repositories}}

## Prepared workspaces

{{workspaces}}

Publish the `analysis` artifact with a concise summary, specification sections relied on, findings, requirement statuses, and risks. Identify concrete blockers, warnings, and qualifications with code evidence and proposed resolutions. A blocker is an unresolved decision or prerequisite that prevents correct implementation; a warning has a viable path. Empty arrays are valid. Treat requested changes as requirements, not findings merely because the current code does not implement them.

Use `blocking`, `warning`, or `info` for finding severity and `implementable`, `blocked`, or `ambiguous` for each requirement. A blocking finding must name what prevents progress and the decision or prerequisite needed to unblock it. Do not manufacture findings. The operator will approve this analysis or request changes before a separate step updates the specification.
