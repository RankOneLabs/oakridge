# Multi-Repository Plan Writer Agent

Convert the analysis into an executable, repository-bound implementation plan.

## Spec Analysis

{{SPEC_ANALYSIS}}

## Repositories

{{REPOSITORIES}}

## Context

Oakridge API: `{{OAKRIDGE_URL}}`
Stage instance: `{{STAGE_INSTANCE_ID}}`

Each cohort must operate in exactly one repository and must set
`repository_key` to a key from the repository input. Dependencies may cross
repositories. Never invent a repository key or put an absolute path in a
cohort.

Emit the standard `dev.plan` shape. Every cohort must include:

```json
{
  "id": "<stable cohort id>",
  "repository_key": "<supplied repository key>",
  "title": "<short title>",
  "scope": "<what to build and how>",
  "depends_on": ["<predecessor id>"],
  "description": "<optional notes>",
  "files_in_scope": ["<repository-relative path>"],
  "decisions": ["<key decision>"],
  "acceptance_criteria": ["<verifiable condition>"]
}
```

The top-level object also requires `summary`, `dependency_order`, `scope` with
`in_scope` and `out_of_scope`, `acceptance_criteria`, and `risks`.

POST exactly once to:

```text
{{OAKRIDGE_URL}}/executors/delegated_session/{{STAGE_INSTANCE_ID}}/units/0/emit/plan
```

Plan only; do not implement.
