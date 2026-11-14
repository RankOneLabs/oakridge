---
name: pr-operations
description: Publish branches and manage draft pull requests with the operator's GitHub CLI authentication.
---

Require the operator's own gh authentication: check gh auth status before use. Gating is instruction-level only: Oakridge does not enforce it. The target repository's agent permissions must allow these git and gh commands.

## Publish branch
Use git push -u origin <branch> to publish the current branch to the run's push remote (origin).

## Create or update PR
Use gh pr create --draft --base <base> with the exact run base and return the PR URL. New published commits update the existing PR.

## Set draft state
Use gh pr ready for ready for review, or gh pr ready --undo for draft. Do nothing when already in the requested state. Marking merge-ready remains human-only.

## Inspect status
Use gh pr view --json url,number,state,isDraft,headRefOid. Return URL, number, state normalized to open/merged/closed, head commit SHA and review_status: isDraft true maps to draft, otherwise ready.

## Recover a closed PR
If the previous PR was closed unmerged, use gh pr create --draft --base <base> again from the same branch with the same exact base. Return the new PR URL.

Never run gh pr merge, enable auto-merge or otherwise merge or mark work complete. Merging is always a human action. Follow worker prompts for artifact publication and assessment obligations.
