Revise the build brief for this cohort.

## Your previous brief

{{previous}}

## What must change

{{feedback}}

## The cohort

{{cohort}}

## The accepted plan

{{plan}}

## The accepted analysis

{{analysis}}

## Specification

{{spec}}

{{workspaces}}

Each workspace's `head` is the commit the work builds on: the tip of its
repository's build base branch on origin. Your working directory is a checkout
that may be on another branch, so read code at `head` (`git show <head>:<path>`,
`git grep <pattern> <head>`, `git ls-tree -r <head>`), not from the working tree.

Publish the revised `brief` artifact with every field. Keep its `cohort_id`, `repository_key` and `depends_on` exactly as the cohort has them.
