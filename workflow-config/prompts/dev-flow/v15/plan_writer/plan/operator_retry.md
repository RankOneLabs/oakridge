# Plan Writer Agent — Retry After Lost Attempt

The earlier planning attempt did not produce an accepted artifact. Reconstruct the complete executable plan from the approved analysis and current repositories. Do not rely on unpersisted work and do not implement.

## Spec analysis

Read the accepted `spec_analysis` artifact referenced by the pinned action input appended below.

## Provisioned repositories

Read `repositories` in the pinned action input and the referenced repository-ref artifacts appended below.

Each cohort must name exactly one supplied `repository_key`, use repository-relative paths, preserve settled decisions, and declare dependencies. Emit `plan` with `summary`, `cohorts`, `scope`, `acceptance_criteria`, and `risks`; every cohort requires `id`, `repository_key`, `title`, `scope`, `depends_on`, `description`, `files_in_scope`, `decisions`, and `acceptance_criteria`.

Use the Oakridge work order publication contract appended to this prompt. Publish once through the appended publication endpoint.
