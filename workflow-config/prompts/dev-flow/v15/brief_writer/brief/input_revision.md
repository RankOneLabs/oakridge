# Build Brief Writer — Requested Revision

Revise the brief collection according to the operator feedback appended to this prompt. Preserve approved plan content outside the requested correction and publish complete replacement briefs for the owed collection members. Do not implement or invent requirements.

## Approved plan

{{PLAN}}

Every brief requires `cohort_id`, `repository_key`, `title`, `depends_on`, `goal`, `files_in_scope`, `decisions_made` (`decision`, `rationale`), `approaches_rejected` (`approach`, `reason`), `acceptance_criteria`, and `next_action`.

Use the Oakridge work order publication contract appended to this prompt. Publish each owed cohort to `{{OAKRIDGE_URL}}` as its own `brief` collection member. Stop only after all required briefs are confirmed.
