# Spec Analysis Agent — Retry After Lost Attempt

The earlier analysis attempt did not produce an accepted artifact. Reinspect the repositories and brief, reconstruct the complete analysis, and publish it once. Do not assume the prior attempt made durable progress. Do not plan or implement.

## Brief

Read `brief_notes` in the pinned action input appended below.

## Repositories

Read `repositories` in the pinned action input and the referenced repository-ref artifacts appended below.

Preserve repository keys. Emit `spec_analysis` as JSON with `summary`, `source_spec_refs`, `findings` (`id`, `description`, `severity`), `requirements` (`id`, `description`, `status`), and `risks` (`description`, `mitigation`). Requested changes are requirements; findings describe actual incompatibilities.

Use the Oakridge work order publication contract appended to this prompt. Publish once through the appended publication endpoint; empty arrays are valid.
