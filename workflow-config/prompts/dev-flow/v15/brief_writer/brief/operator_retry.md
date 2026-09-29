# Build Brief Writer — Retry After Lost Attempt

The earlier brief-writing attempt did not finish the required collection. Reconstruct the complete set from the approved plan, inspect which collection members the appended publication contract still requires, and publish every owed `brief`. Do not implement or invent requirements.

## Approved plan

{{PLAN}}

Every brief requires `cohort_id`, `repository_key`, `title`, `depends_on`, `goal`, `files_in_scope`, `decisions_made` (`decision`, `rationale`), `approaches_rejected` (`approach`, `reason`), `acceptance_criteria`, and `next_action`.

Use the Oakridge work order publication contract appended to this prompt. Publish each owed cohort to `{{OAKRIDGE_URL}}` as its own collection member. Stop only after all required briefs are confirmed.
