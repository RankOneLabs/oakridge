Derive a reviewable task list from the approved revised specification and publish only the `tasks` artifact. The spec has its own editor and review; do not republish it.

## Approved revised specification

{{revised_spec}}

## Approved analysis

{{approved_analysis}}

Publish `{ "tasks": [{ "id": "...", "description": "...", "requirement_ids": [] }] }`. Give every task a concrete description and an id unique in this run's task list. Cite the approved analysis requirement ids it came from in `requirement_ids`. An empty list means no link, never unknown; do not infer a link from prose. An id names a logical task, not its bytes: a deliberately reworded task keeps its id and genuinely new work gets a new id.
