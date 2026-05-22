# safir-py

HTTP client for safir's task/run/phase/handoff API. Shared by `planner1`
and `builder`.

## Shape

Thin `httpx` client. No CLI. Responses are returned as `dict[str, Any]`;
there are no Pydantic models yet (the schema lives in the upstream
service). Used by `builder` for its task/run/phase/handoff surface, and
by `planner1` for environment-variable helpers — planner1 still keeps a
thin local `SafirClient` for its `submit_plan` path.

## Dependencies

- `httpx`

## Commands

```bash
uv sync                          # installs deps
uv run pytest                    # runs the test suite (uses pytest-httpx)
uv run ruff check                # lint
uv run ruff format               # format
uv run mypy                      # type-check
```

@../standards/core.md
@../standards/python.md
@../standards/backend.md
