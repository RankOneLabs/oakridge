Analyze the specification against the prepared repositories. Do not begin implementation.

## Specification

{{spec}}

## Repositories

{{repositories}}

Each repository is prepared at the path in its workspace:

{{workspaces}}

Each workspace's `head` is the commit the work builds on: the tip of its
repository's build base branch on origin. Your working directory is a checkout
that may be on another branch, so read code at `head` (`git show <head>:<path>`,
`git grep <pattern> <head>`, `git ls-tree -r <head>`), not from the working tree.

## Finding severity and requirement status

Assign severity by the consequence for delivering the specification, not by how
much code must change or how important the feature sounds. Use exactly one of
these values for each finding:

- `blocking` — a required outcome cannot be planned or implemented correctly
  until a specific unresolved contradiction, missing external prerequisite, or
  product decision is addressed. Name the affected requirement, the evidence,
  why code inspection or ordinary implementation cannot resolve it, and the
  decision or prerequisite needed to unblock it.
- `warning` — a concrete incompatibility or material ambiguity needs attention,
  but there is a viable path consistent with the specification and existing
  contracts. Describe that path and the remaining consequence or trade-off.
  Planning can proceed without inventing product behavior.
- `info` — a verified discrepancy has no material effect on feasibility or
  correctness; it only provides useful context. Omit observations that do not
  help the planner.

Examples: mutually exclusive required behaviors with no stated precedence are
`blocking`; an existing caller that needs an adaptation the specification
permits is a `warning`; a stale file reference whose intended target is
unambiguous is `info`. A new endpoint, missing tests, a schema change the
specification explicitly requests, or a large implementation effort is ordinary
requirement work, not automatically a finding or a blocker. General test or
dependency concerns belong in the risks unless they expose a specific
discrepancy. Do not report the intended before-to-after difference itself as a
finding.

Set each requirement's status separately: `implementable` when the required
behavior is clear and feasible, even if substantial work remains; `blocked`
when a demonstrated prerequisite or contradiction prevents delivery;
`ambiguous` when materially different required behaviors remain possible and
the specification and code do not select one. Ambiguity is not automatically
blocking: use `blocking` only when the unresolved choice prevents correct
planning or implementation.

Before publishing, recheck every label against these definitions. Each
`blocking` finding must identify what prevents progress and what would unblock
it; each `blocked` or `ambiguous` requirement must explain the reason in its
description. Do not manufacture findings: no findings is correct when the
specification is implementable without discrepancies.

## What to publish

Publish the `analysis` artifact: a summary, the specification sections you relied on (`source_spec_refs`), findings with a severity (`blocking`, `warning` or `info`), the requirements with their status (`implementable`, `blocked` or `ambiguous`), and the risks with their mitigations.

Route remote git and pull request operations through gated-review.
