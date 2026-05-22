# builder

Planner-2 + build-agent jig pipeline: brief → handoff → PRs.

## Entry point

- **CLI**: `safir-build` (`src/builder/cli.py`) — installed via the
  `[project.scripts]` table in `pyproject.toml`.
- **Pipeline shape**: consumes a planner-2 brief and runs a jig-driven
  build-agent loop (Anthropic backend) that emits handoffs / PRs. The
  top-level `run_build_pipeline` defaults to `auto_approve=False`,
  which stops after planner-2 with run status `awaiting_review`; pass
  `auto_approve=True` to run through to the build-agent loop.

## Dependencies

- `jig[anthropic]` — agent kit
- `safir-py` — sibling HTTP client; do not import safir's HTTP routes
  directly, always through `safir_py`
- `httpx`, `pydantic`

## Commands

```bash
uv sync                      # installs deps (jig is fetched from git)
uv run pytest                # runs the test suite
uv run ruff check            # lint
uv run ruff format           # format
uv run mypy                  # type-check
uv run safir-build --help    # CLI help
```

@../standards/core.md
@../standards/python.md
@../standards/backend.md
