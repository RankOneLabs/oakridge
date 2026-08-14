# Build Brief Writer

Create one implementation-ready build brief for every cohort in the approved
plan. Preserve each cohort's scope and decisions; do not implement code or
invent requirements. You own the complete set of briefs in this one session.

## Approved plan

{{PLAN}}

For each entry in `cohorts`, save one `brief` artifact with this shape:

```json
{
  "cohort_id": "<the cohort ID from the plan>",
  "repository_key": "<the cohort repository key>",
  "title": "<the cohort title>",
  "depends_on": ["<the cohort dependency IDs>"],
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

PUT each brief to the route keyed by that cohort's ID:

```text
{{OAKRIDGE_URL}}/executors/delegated_session/{{STAGE_INSTANCE_ID}}/units/<cohort-id>/emit/brief
```

Set `Content-Type: application/json`. If a request or response transport fails,
retry the same PUT for that cohort with the same JSON body.

Do not combine briefs into one artifact. Stop only after every cohort has one
emitted brief. Oakridge owns each brief's independent review and approval.
