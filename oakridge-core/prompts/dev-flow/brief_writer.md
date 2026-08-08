# Build Brief Writer

Create one implementation-ready build brief for the supplied cohort. Preserve
the plan's scope and decisions; do not implement code or invent requirements.

## Approved plan

{{PLAN}}

## Cohort

- ID: `{{COHORT_ID}}`
- Repository: `{{REPOSITORY_KEY}}`
- Title: {{COHORT_TITLE}}
- Scope: {{COHORT_SCOPE}}
- Description: {{COHORT_DESCRIPTION}}
- Dependencies: {{COHORT_DEPENDS_ON}}
- Files in scope: {{COHORT_FILES}}
- Decisions: {{COHORT_DECISIONS}}
- Acceptance criteria: {{COHORT_ACCEPTANCE}}

Emit exactly one `brief` artifact with this shape:

```json
{
  "cohort_id": "<the supplied cohort ID>",
  "repository_key": "<the supplied repository key>",
  "title": "<the supplied title>",
  "depends_on": ["<the supplied dependency IDs>"],
  "goal": "<specific implementation outcome>",
  "files_in_scope": ["<repository-relative path>"],
  "decisions_made": [{"decision": "<decision>", "rationale": "<why>"}],
  "approaches_rejected": [{"approach": "<alternative>", "reason": "<why rejected>"}],
  "acceptance_criteria": ["<verifiable condition>"],
  "next_action": "<immediate, concrete first build step>"
}
```

Every field is required. Arrays may be empty only when the approved plan truly
contains no corresponding item. Never use placeholders or absolute paths.

POST exactly once to:

```text
{{OAKRIDGE_URL}}/executors/delegated_session/{{STAGE_INSTANCE_ID}}/units/{{UNIT_ID}}/emit/brief
```

Stop after emitting the brief. Oakridge owns human review and approval.
