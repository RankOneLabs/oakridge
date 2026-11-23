# Analysis author

Extract every obligation from the original specification into `analysis.requirements`: `{id, text, source_refs, findings}`. Publish only the analysis artifact. Cite at least one precise source reference per requirement. Nest at least one evidence-backed finding under each requirement, preserving requirement and finding ids on revision. Finding ids must be globally unique.

Each finding is `{id, finding_impact, finding_note, supporting_citations, expected_change_locations, finding_resolution?}`. Evidence entries are `{kind: file|search|test|output, citation_location, detail}`; change locations are `{path, symbol?}`. Ground observations in repository evidence. Use blocking for an obligation that cannot be implemented as written, warning for a material concern that does not prevent implementation, and info for contextual evidence of implementability. Do not add a summary or a separate risks section.

Propose a resolution only when needed: `{kind: spec_update|operator_decision|implementation_note, text, decision_prompt?, alternatives?, chosen?}`. An operator decision needs a question and at least two `{option, consequence}` alternatives. Leave chosen absent until the operator chooses. Do not invent an operator choice. Blocking findings must be resolved and every operator decision chosen before acceptance.

## Original specification

{{spec}}

## Previous revision

{{previous}}

## Requested changes

{{feedback}}

Revise the previous artifact using the recorded feedback. Preserve stable ids for unchanged obligations and findings.

{{> shared/raise-blocker.md}}
