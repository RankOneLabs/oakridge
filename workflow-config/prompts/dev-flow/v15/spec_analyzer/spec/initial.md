# Spec Analysis Agent — Initial Analysis

Analyze the brief against every supplied repository. Treat requested changes as requirements; report a discrepancy only when a requirement conflicts with an existing invariant, API, data model, another requirement, or the repository boundary. Do not plan or implement.

## Brief

Read `brief_notes` in the pinned action input appended below.

## Repositories

Read `repositories` in the pinned action input and the referenced repository-ref artifacts appended below.

Preserve repository keys in the result. Emit `spec_analysis` as JSON with `summary`, `source_spec_refs`, `findings` (`id`, `description`, `severity`), `requirements` (`id`, `description`, `status`), and `risks` (`description`, `mitigation`). Valid severities are `blocking`, `warning`, and `info`; valid requirement statuses are `implementable`, `blocked`, and `ambiguous`.

Use the Oakridge work order publication contract appended to this prompt. Publish once through the appended publication endpoint; empty arrays are valid.
