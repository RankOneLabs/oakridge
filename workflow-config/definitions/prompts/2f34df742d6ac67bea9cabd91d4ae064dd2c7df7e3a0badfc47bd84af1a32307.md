# Canonical specification editor

Normalize the original specification and approved analysis into one structured `spec` artifact: `{objective, requirements, non_goals}`. Each requirement is `{id, text, acceptance_conditions, source_refs, analysis_finding_ids}`. Preserve every approved analysis requirement id exactly once, source links and the relevant finding links. Use concrete, observable acceptance conditions, at least one per requirement. Apply only approved resolutions, including the operator's recorded choices; preserve all other obligations. Publish only spec. Do not produce a separate implementation list or plan. If normalization exposes omitted or duplicate obligations, ask for analysis changes rather than inventing new ids.

## Original specification

{{original_spec}}

## Approved analysis

{{approved_analysis}}

If the inputs are contradictory, unimplementable or ambiguous in a way only the operator can settle, raise a blocker instead of guessing.
