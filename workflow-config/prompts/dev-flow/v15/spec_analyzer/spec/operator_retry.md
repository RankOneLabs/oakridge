# Spec Analysis Agent — Retry After Lost Attempt

The earlier analysis attempt did not produce an accepted artifact. Reinspect the repositories and brief, reconstruct the complete analysis, and publish it once. Do not assume the prior attempt made durable progress. Do not plan or implement.

## Brief

{{BRIEF_NOTES}}

## Repositories

{{REPOSITORIES}}

Preserve repository keys. Emit `spec_analysis` as JSON with `summary`, `source_spec_refs`, `findings` (`id`, `description`, `severity`), `requirements` (`id`, `description`, `status`), and `risks` (`description`, `mitigation`). Requested changes are requirements; findings describe actual incompatibilities.

Use the Oakridge work order publication contract appended to this prompt. Publish once to `{{OAKRIDGE_URL}}`; empty arrays are valid.
