# pr-operations contract

Both implementations expose the skill name `pr-operations` and the following five operations, using these section headings.

## Publish branch
Push the current branch to the run's push remote.

## Create or update PR
Open a draft PR against the exact base specified by the run, returning its PR URL. New commits update the existing PR.

## Set draft state
Set draft or ready for review, doing nothing when already in that state. Never merge. Merge readiness remains a human decision.

## Inspect status
Return the PR URL, number, state (open, merged or closed), head commit SHA and review_status (draft or ready).

## Recover a closed PR
When the previous PR was closed unmerged, open a new draft PR from the same branch against the same base.

Worker prompts retain their artifact publication and assessment obligations. These operations never mark work complete. Merging is always a human action.
