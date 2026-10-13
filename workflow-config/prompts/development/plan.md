Plan the implementation from the accepted analysis, the specification and the prepared repositories.

## Specification

{{spec}}

## Accepted analysis

{{analysis}}

## Repositories

{{repositories}}

{{workspaces}}

## What to publish

Publish the `plan` artifact. Split the work into cohorts, each with:

- a stable `id`: an identifier with no `/` or `\`, unique in the plan
- the `repository_key` of the repository it changes: one of the repository keys above
- `depends_on`: the ids of the cohorts that must merge before it starts, with no cycle
- its title, scope, files in scope, decisions and acceptance criteria

Name at least one cohort. Give a `dependency_order`, the scope in and out, the plan's acceptance criteria and its risks. A plan that breaks these rules is returned to you with what to fix.
