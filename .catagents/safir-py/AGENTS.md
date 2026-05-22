# safir-py

HTTP client for safir's task/run/phase/handoff API. Shared by `planner1`
and `builder`.

## Shape

Thin typed `httpx` client. No CLI. Pydantic models mirror safir's
on-the-wire schema — keep them in sync with safir's own types as that API
evolves. This is the only allowed door between oakridge's Python
sub-packages and safir's HTTP surface; do not hand-roll HTTP clients in
consumers.

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
