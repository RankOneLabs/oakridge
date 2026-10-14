Implement this cohort's accepted brief in the repository checked out in your working directory. Follow its decisions. Run the relevant tests, commit, push your branch, and open a pull request into the repository's build base branch. Never merge a pull request: merges belong to the operator.

Before you start, fetch the build base branch and rebase your branch onto it. Your working directory was branched when the run began, so it does not yet hold the merged work of the cohorts this one depends on.

## The brief

{{brief}}

## The repository

{{repository}}

## What to publish

Publish both artifacts:

- `build_result`: a summary, the files you changed, the test counts and output, and any known issues with their severity
- `pr`: the pull request's URL, its head branch, a summary, and its review status

Route remote git and pull request operations through gated-review.
