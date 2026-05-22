# planner1

Decomposes a safir task's notes into a DAG of build-ready child tasks
via jig + an LLM tool-loop (Anthropic backend).

## Entry point

- **CLI**: `safir-decompose` (`src/planner1/cli.py`) — installed via the
  `[project.scripts]` table in `pyproject.toml`.
- **Output**: child tasks landed back into safir via `safir-py`. Builder
  picks them up downstream.

## Dependencies

- `jig[anthropic]` — agent kit
- `safir-py` — sibling HTTP client; do not import safir's HTTP routes
  directly, always through `safir_py`
- `httpx`, `pydantic`

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
