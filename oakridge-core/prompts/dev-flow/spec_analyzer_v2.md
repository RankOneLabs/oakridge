# Multi-Repository Spec Analysis Agent

Analyze the development brief against every relevant supplied repository.

## Brief

{{BRIEF_NOTES}}

## Repositories

{{REPOSITORIES}}

## Context

Oakridge API: `{{OAKRIDGE_URL}}`
Stage instance: `{{STAGE_INSTANCE_ID}}`

Repository keys are stable identifiers; preserve them when describing findings
and scope.

Treat the brief's requested changes as requirements, not discrepancies merely
because the current code does not implement them yet. A discrepancy exists only
when a requested feature or constraint is incompatible with the current
codebase: for example, it contradicts an existing invariant, depends on an API
or data model that cannot support it, conflicts with another requirement, or
cannot be implemented within the supplied repository boundaries. Describe the
specific incompatibility and evidence from the code. Do not report the intended
before-to-after difference itself as a finding.

Produce this JSON body:

```json
{
  "summary": "<2-4 sentence executive summary>",
  "source_spec_refs": ["<brief quote or label>"],
  "findings": [
    { "id": "<f1>", "description": "<finding and repository key>", "severity": "blocking|warning|info" }
  ],
  "requirements": [
    { "id": "<r1>", "description": "<required change>", "status": "implementable|blocked|ambiguous" }
  ],
  "risks": [
    { "description": "<risk>", "mitigation": "<suggested approach>" }
  ]
}
```

Use PUT as the canonical idempotent operation. Reuse the same `Idempotency-Key` only when retrying the identical body (the same key with a different body is refused as `idempotency_conflict`). Publication is final for this work order: an output slot takes one artifact, and a second PUT with a different body is refused — `slot_pending` while the first awaits review, `slot_already_released` once it is released. There is no withdraw, supersede, or correction call, so check the body before you PUT it. If you find after publishing that the artifact is wrong, do not PUT again: say exactly what is wrong, and where, in your final message so the reviewer can act on it. Do not emit speculative duplicates. Stop only after Oakridge confirms the typed result.

PUT the JSON body to:

`<work-order-id>` and the `Work-Order-Capability` value are given in the **Oakridge v2 artifact publication** section at the end of this prompt; use them verbatim.

```http
PUT {{OAKRIDGE_URL}}/work-orders/<work-order-id>/emit/spec_analysis
Work-Order-Capability: <capability>
Content-Type: application/json

<the JSON body above>
```

If the request or response transport fails, retry the same PUT with the same JSON body.

Do not plan or implement. Empty arrays are valid.
