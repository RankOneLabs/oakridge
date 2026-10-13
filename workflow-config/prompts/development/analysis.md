Analyze the specification against the prepared repositories. Do not begin implementation.

## Specification

{{spec}}

## Repositories

{{repositories}}

Each repository is prepared at the path in its workspace:

{{workspaces}}

## What to publish

Publish the `analysis` artifact: a summary, the specification sections you relied on (`source_spec_refs`), findings with a severity (`blocking`, `warning` or `info`), the requirements with their status (`implementable`, `blocked` or `ambiguous`), and the risks with their mitigations.

Route remote git and pull request operations through gated-review.
