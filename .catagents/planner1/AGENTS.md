# planner1

Decomposes a parent task's notes into a DAG of build-ready child tasks
via jig + an LLM tool-loop (Anthropic backend).

## Entry point

- **CLI**: `safir-decompose` (`src/planner1/cli.py`) — installed via the
  `[project.scripts]` table in `pyproject.toml`. (The `safir-` prefix is
  legacy naming; the CLI submits a decomposition plan to the parent-task
  HTTP endpoint.)
- **Output**: a decomposition plan (cohorts of build-ready child tasks),
  submitted via `submit_plan` against the parent task's HTTP endpoint.

## Dependencies

- `httpx` — direct exception type used at the CLI IO boundary
- `jig[anthropic]` — agent kit
- `safir-py` — sibling HTTP client (submit_plan + all other surface
  lives there now)
- `pydantic`

## Commands

```bash
uv sync                          # installs deps (jig is fetched from git)
uv run pytest                    # runs the test suite
uv run ruff check                # lint
uv run ruff format               # format
uv run mypy                      # type-check
uv run safir-decompose --help    # CLI help
```

@../standards/core.md
@../standards/python.md
@../standards/backend.md
