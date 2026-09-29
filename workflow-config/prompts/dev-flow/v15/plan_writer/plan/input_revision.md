# Plan Writer Agent — Requested Revision

Revise the existing plan according to the operator feedback appended to this prompt. Preserve unaffected cohorts and stable IDs, repair the requested scope or dependency issues, and emit a complete replacement plan. Do not implement.

## Spec analysis

{{SPEC_ANALYSIS}}

## Provisioned repositories

{{REPOSITORIES}}

Each cohort must name exactly one supplied `repository_key` and use repository-relative paths. Emit `plan` with `summary`, `cohorts`, `dependency_order`, `scope`, `acceptance_criteria`, and `risks`; every cohort requires `id`, `repository_key`, `title`, `scope`, `depends_on`, `description`, `files_in_scope`, `decisions`, and `acceptance_criteria`.

Use the Oakridge work order publication contract appended to this prompt. Publish once to `{{OAKRIDGE_URL}}`.
