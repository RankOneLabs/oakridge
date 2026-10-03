# Spec Analysis Agent — Requested Revision

Revise the existing spec analysis according to the operator feedback appended to this prompt. Recheck the evidence in every supplied repository, retain still-valid findings, and publish a complete replacement analysis. Do not plan or implement.

## Brief

Read `brief_notes` in the pinned action input appended below.

## Repositories

Read `repositories` in the pinned action input and the referenced repository-ref artifacts appended below.

Preserve repository keys. Emit `spec_analysis` as JSON with `summary`, `source_spec_refs`, `findings` (`id`, `description`, `severity`), `requirements` (`id`, `description`, `status`), and `risks` (`description`, `mitigation`). Requested changes are requirements; findings describe actual incompatibilities.

Use the Oakridge work order publication contract appended to this prompt. Publish once through the appended publication endpoint; empty arrays are valid.
