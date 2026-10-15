Revise your implementation plan.

## Your previous plan

{{previous}}

## What must change

{{feedback}}

## Specification

{{spec}}

## Accepted analysis

{{analysis}}

## Repositories

{{repositories}}

{{workspaces}}

Each workspace's `head` is the commit the work builds on: the tip of its
repository's build base branch on origin. Your working directory is a checkout
that may be on another branch, so read code at `head` (`git show <head>:<path>`,
`git grep <pattern> <head>`, `git ls-tree -r <head>`), not from the working tree.

Publish the revised `plan` artifact with every field. Every cohort names one of the repository keys, cohort ids are unique, and `depends_on` names other cohorts without a cycle.
