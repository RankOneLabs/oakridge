# safir-py

HTTP client for safir's task/run/phase/handoff API. Shared by `planner1`
and `builder`.

## Shape

Thin `httpx` client. No CLI. Responses are parsed into Pydantic v2 models
defined in `src/safir_py/models.py`, which mirror safir's wire shapes 1:1
(zod schemas in `safir/src/shared/schema.ts` plus the db / route shapes
that aren't in the shared file). The model module is the public type
surface — consumers do `from safir_py import Run, Phase, Plan, ...`.
Models use `extra='ignore'` so a new server field does not break older
clients. Used by `builder` and `planner1`; `submit_plan` lives here too,
so planner1 no longer needs a local client.

## Dependencies

- `httpx`
- `pydantic` (v2)

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
