Write the build brief for one cohort of the accepted plan.

## The cohort

{{cohort}}

## The accepted plan

{{plan}}

## The accepted analysis

{{analysis}}

## Specification

{{spec}}

## Prepared repositories

{{workspaces}}

Each workspace's `head` is the commit the work builds on: the tip of its
repository's build base branch on origin. Your working directory is a checkout
that may be on another branch, so read code at `head` (`git show <head>:<path>`,
`git grep <pattern> <head>`, `git ls-tree -r <head>`), not from the working tree.

## What to publish

Publish the `brief` artifact for this cohort only. Keep its `cohort_id`, `repository_key` and `depends_on` exactly as the cohort has them. Carry forward its decisions with their rationale, the approaches rejected and why, the files in scope and the acceptance criteria, and state the goal and the builder's next action.
