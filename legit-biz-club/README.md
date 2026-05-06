# legit-biz-club

The workspace layer of oakridge: multi-agent collaboration over a shared artifact, built on jig (agent kit) and consumed by kbbl (operator surface).

**Status:** v1 build complete. All five phases (foundation, incremental coordination, convergence, evals + memory commit, study harness) are shipped on `main` across PRs #19, #23, and #24. Workstream D — actually running the v1 study — is research output and lives outside this package.

## Layout

```text
legit-biz-club/
├── pyproject.toml
├── src/
│   └── legit_biz_club/
│       ├── core/             # data model + lifecycle state machine
│       ├── composition.py    # composition policy + heterogeneity check
│       ├── coordination/     # incremental + convergence; mediator, OCC, consensus mechanisms, JigProposer
│       ├── eval/             # code + prose eval primitives (jig-grader-backed)
│       ├── memory.py         # operator-driven MemoryCommitter (Python API)
│       ├── study/            # four-condition study harness — targets, conditions, runner, results
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

## Running a project

legit-biz-club is a **library** — there is no CLI, no UI, and no config-file driver in v1. The operator (or a script) writes Python that builds the agents, project, mediator, and proposers, then awaits a coordinator. kbbl is an *observation* surface (workspace events arrive in its inbox); it does not drive legit-biz-club.

Two API levels:

- **One project:** wire `ProjectCoordinator(...)` directly. Use this when you have one artifact, one brief, one ensemble, and no need for the study harness.
- **Study harness:** call `run_cell(...)` for one (target × condition) pair, or `run_study(...)` for the full grid. Use this when you want the harness's per-cell output layout, fresh-memory-per-run guarantee, and `CellMetrics` capture.

A worked example is in `scripts/run_one_project.py` — drives a single cell end-to-end against real LLMs:

```bash
export ANTHROPIC_API_KEY=...    # jig reads provider env vars
cd legit-biz-club
uv run python scripts/run_one_project.py
```

The script's config block is hardcoded; edit-and-rerun is the iteration loop in v0. Output lands under `legit-biz-club/.run/<timestamp>/` (gitignored). Each cell directory contains:

- `<artifact_filename>` — the final artifact
- `commits/v0001.<ext>`, `v0002.<ext>`, ... — per-commit snapshots (one per successful apply, in order; extension matches the artifact's, e.g. `.md` for prose targets, `.py` for single-file CODE)
- `events.jsonl` — workspace-event log (one line per event, with timestamp + kind + payload)
- `eval_scores.json` — present when a `grader_factory` is wired and produces scores. Shape: `{"scores": [{"dimension", "value", "source"}, ...]}`. The wrapper envelope leaves room for future grader metadata. Absent file means "no grader was wired" — readers shouldn't distinguish that from `{"scores": []}`.
- `agent_memory/` — per-agent SqliteStore files (currently unused by `JigProposer`; placeholder for v1.x)

`commits`, `agent_memory`, and `events.jsonl` are reserved sidecar names — `run_cell` rejects targets whose `artifact_filename` collides with any of them.

## Architecture

Per the design memo:

- Agents are persistent peers with their own memory and identity, accumulating skill across projects.
- Projects are bounded contexts that own one artifact, one brief, and an enrolled ensemble (default 5 agents).
- Coordination is substrate-mediated, not message-passing — agents read the canonical artifact state plus, in convergence rounds, peer proposals exposed as substrate.
- Three coordination modes: incremental commits (default), convergence (coordinator-internal — driven by the project's coordination-protocol config, not operator-triggered), and escalation (automated `DisagreementSurface` default; operator-in-loop is an optional callback).
- Pluggable consensus mechanism, round budget policy, disagreement surface, and termination policy — v1 ships sensible defaults behind interfaces so v2+ can swap.
- Memory commit is **operator-driven and Python-API-only** in v1 — the operator (or a script) calls `MemoryCommitter.commit(...)` after a project ends to persist approved observations into the agent's jig SqliteStore. A kbbl review UI is deferred; kbbl stays out of the memory commit path.

## Polyglot setup

This package is Python (≥3.12, async, pydantic 2). It consumes jig directly as a Python library; jig is fetched from git via `[tool.uv.sources]`. The polyglot boundary with kbbl (TypeScript) lives at `adapters/kbbl/`, where a Python HTTP client calls into kbbl's Hono server. Trust model is Tailscale-network trust (same as kbbl's existing PWA gate).

The directory name `legit-biz-club` avoids collision with Bun's package-management "workspaces" feature; per the design memo, the conceptual term for what this package implements is "the workspace."
