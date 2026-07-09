# legit-biz-club

The workspace layer of oakridge: multi-agent collaboration over a shared
artifact, built on jig (agent kit) and consumed by kbbl (operator
surface).

**Status:** v1 build complete. All five phases (foundation, incremental
coordination, convergence, evals + memory commit, study harness) shipped
on `main` across PRs #19, #23, and #24. Workstream D — actually running
the v1 study — is research output and lives outside this package.

## Shape

Python library; no CLI. Consumers (kbbl, study scripts) call the Python
API directly. See `README.md` for the per-module layout under
`src/legit_biz_club/` — core, composition, coordination, eval, memory,
study, adapters.

## Dependencies

- `jig[anthropic,openai,ollama]` — agent kit, multi-provider
- `pydantic`, `httpx`

The `adapters/kbbl/` module is a Python HTTP client against kbbl's TS
server. All cross-language calls go through it; do not hand-roll HTTP
elsewhere.

## Commands

```bash
uv sync                      # installs deps (jig is fetched from git)
uv run pytest                # runs the test suite
uv run pytest -q tests/study # study harness tests only (slower)
uv run ruff check            # lint
uv run ruff format           # format
uv run mypy                  # type-check
```

@../standards/core.md
@../standards/python.md
