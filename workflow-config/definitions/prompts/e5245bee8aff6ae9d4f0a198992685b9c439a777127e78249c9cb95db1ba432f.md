Review this repository's integration pull request. Accept it once you are satisfied; the integration completes when the pull request merges. Or request changes and say what must change.

## The repository

{{repository}}

## The completed cohorts

{{cohorts}}

## The task obligations

{{briefs}}

## The pull request

{{pr}}

## Integration assessment

{{assessment}}

## What the forge reports

{{pr_state}}

The briefs above are this repository's task obligations. Check that the assessment covers every distinct task id in them, on the integration branch and with the contributions of every cohort sharing that id. Findings carry `subjects`: several findings for one task, several tasks on one finding and `subjects: []` are all valid. The assessment has no build result subject.

Findings name explicit subjects: cohort assessments use build_item ids from the brief; integration assessments use task ids or cohort-qualified build_item ids from applicable briefs. Review their evidence against the build items.
Do not accept the PR while the latest integration assessment has failed validation.
