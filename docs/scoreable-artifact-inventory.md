# Scoreable artifact inventory

Published grading configuration binds questions to the selectors listed in the
[observation extraction catalogue](observation-extraction-catalogue.md).
Observation selects those extractors by definition ID, stage key, artifact key,
and resolved schema version. Unknown declarations produce an
`unregistered_declaration` issue.

| Workflow | Artifact | Scoreable items |
| --- | --- | --- |
| Development | Analysis | Requirements and findings within requirements |
| Development | Specification | Canonical requirements, with links to cited analysis findings |
| Development | Plan | Per-cohort requirement allocations |
| Development | Brief | Build items and technical decisions |
| Development | Assessment | Item assessments, additional findings, feedback proposals, and assignment verifications |
| Study | Plan | Cases, slice criteria, iteration triggers, hypotheses, and outcomes |
| Study | Slice build and expansion | Case qualifications |
| Study | Slice report | Criterion marks, trigger marks, and paid results |
| Study | Slice, expansion, and integration assessments | Item assessments, additional findings, feedback proposals, and assignment verifications |
| Study | Freeze | Cohort files and their links to cases |
| Core | Blocker | Blocker body |

Development logical task occurrences use the `requirement` task kind. Study
occurrences use `case`, `criterion`, `trigger`, or `cohort_file`. The same local
ID in different task kinds produces separate histories and grades. Proposals
derive from their authored revision and pointer citations. Assignment
verifications are gradeable as captured items.
