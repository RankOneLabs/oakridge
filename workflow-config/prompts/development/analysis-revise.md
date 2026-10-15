Revise your analysis of the specification. The operator reviewed the analysis below and asked for changes.

## Your previous analysis

{{previous}}

## What must change

{{feedback}}

## Specification

{{spec}}

## Repositories

{{repositories}}

{{workspaces}}

Each workspace's `head` is the commit the work builds on: the tip of its
repository's build base branch on origin. Your working directory is a checkout
that may be on another branch, so read code at `head` (`git show <head>:<path>`,
`git grep <pattern> <head>`, `git ls-tree -r <head>`), not from the working tree.

Publish the revised `analysis` artifact with every field, not only the ones that changed.
