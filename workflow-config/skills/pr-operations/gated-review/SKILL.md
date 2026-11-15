---
name: pr-operations
description: Publish branches and manage draft pull requests through the gated-review gateway.
---

Use the MCP server named `gated-review` for all remote git and PR operations. Do not use shell git push, git pull, git fetch or the gh CLI. Local commits, git status and git rev-parse are fine. For remote reads use git.fetch and git.pull.

## Publish branch
Use git.push (alias git_push) to publish the current branch to the run's push remote.

## Create or update PR
Use open_pr with draft: true and base set to the exact run base. Return the PR URL. Publishing new commits updates an existing PR.

## Set draft state
Use set_pr_draft for draft or ready for review; no-op when already in that state. Merging and marking merge-ready are human-only; never invoke merge_pr or mark_merge_ready.

## Inspect status
Use pr_status. Report URL, number, state (open/merged/closed), head commit SHA and review_status draft or ready.

## Recover a closed PR
If closed unmerged, use open_pr again with draft: true, the same branch and exact base, and return the new URL.

Follow worker prompts for all artifact publication and assessment obligations. Never mark work complete through PR operations. Merging is always a human action.
