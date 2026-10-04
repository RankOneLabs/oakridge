# Build Brief Writer — Initial Briefs

Create one implementation-ready `brief` artifact for every cohort in the approved plan. Preserve scope, repository assignment, dependencies, decisions, and acceptance criteria. Do not implement or invent requirements.

## Approved plan

Read the accepted `plan` artifact referenced by the pinned action input appended below.

Every brief requires `cohort_id`, `repository_key`, `title`, `depends_on`, `goal`, `files_in_scope`, `decisions_made` (`decision`, `rationale`), `approaches_rejected` (`approach`, `reason`), `acceptance_criteria`, and `next_action`.

Use the Oakridge work order publication contract appended to this prompt. Publish every cohort through the appended publication endpoint as a separate `briefs` collection member using its cohort ID. Stop only after all briefs are confirmed.
