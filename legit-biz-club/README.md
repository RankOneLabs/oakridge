# legit-biz-club

The workspace layer of oakridge: multi-agent collaboration over a shared artifact, built on jig (agent kit) and consumed by kbbl (operator surface).

**Status:** v1 in progress. Foundation (data model, lifecycle, composition policy, polyglot adapter scaffolding) is the first PR; coordination modes, evals, memory commit, and the study harness follow per the implementation plan.

## Layout

```text
legit-biz-club/
├── pyproject.toml
├── src/
│   └── legit_biz_club/
│       ├── core/             # data model + lifecycle state machine
│       ├── composition.py    # composition policy + heterogeneity check
│       └── adapters/
│           └── kbbl/         # Python HTTP client against kbbl's TS server
└── tests/
```

## Development

```bash
uv sync                      # installs deps (jig is fetched from git)
uv run pytest                # runs the test suite
uv run ruff check            # lint
uv run mypy src              # type-check (strict)
```

## Architecture

Per the design memo:

- Agents are persistent peers with their own memory and identity, accumulating skill across projects.
- Projects are bounded contexts that own one artifact, one brief, and an enrolled ensemble (default 5 agents).
- Coordination is substrate-mediated, not message-passing — agents read the canonical artifact state plus, in convergence rounds, peer proposals exposed as substrate.
- Three coordination modes: incremental commits (default), convergence rounds (operator-triggered, multi-round protocol with peer-aware revision), and escalation (mechanical disagreement surface, operator picks).
- Pluggable consensus mechanism, round budget policy, disagreement surface, and termination policy — v1 ships sensible defaults behind interfaces so v2+ can swap.

## Polyglot setup

This package is Python (≥3.12, async, pydantic 2). It consumes jig directly as a Python library; jig is fetched from git via `[tool.uv.sources]`. The polyglot boundary with kbbl (TypeScript) lives at `adapters/kbbl/`, where a Python HTTP client calls into kbbl's Hono server. Trust model is Tailscale-network trust (same as kbbl's existing PWA gate).

The directory name `legit-biz-club` avoids collision with Bun's package-management "workspaces" feature; per the design memo, the conceptual term for what this package implements is "the workspace."
