# oakridge

Multi-agent workspace built on jig (separate repo, agent kit) and kbbl (operator surface for CLI coding agents). The trajectory is described in `comms/multi-agent-collab-design.md`.

This repo is **mid-restructure**. Until the workspace layer ships, oakridge is a top-level monorepo containing kbbl as its operational sub-package. See `comms/oakridge-restructure-spec.md` for the restructure plan.

## Layout

```text
oakridge/
├── kbbl/                  # operator surface for CLI coding agents (v0)
├── legit-biz-club/        # workspace layer (v1, placeholder)
├── docs/                  # public-facing documentation (placeholder)
└── comms/                 # internal architecture memos and specs (gitignored)
```

## Sub-packages

- **kbbl** — the operator surface. Standalone product; works without the workspace layer. See `kbbl/README.md` for usage and architecture.
- **legit-biz-club** — the workspace layer (multi-agent collaboration over a shared artifact). v1 build, not implemented yet. Placeholder.

## Quick start

For the v0 operator surface (single-agent CC sessions over Tailscale):

```bash
bun install
./kbbl/scripts/cc-start /path/to/your/repo
```

See `kbbl/README.md` for full usage.

## Development

```bash
bun install                # installs deps for all sub-packages
bun run typecheck          # typecheck across the repo
```

## Trajectory

The architectural direction is laid out in:

- `comms/multi-agent-collab-design.md` — the workspace design memo
- `comms/oakridge-restructure-spec.md` — the restructure spec being executed

Both are internal-comms-grade documents (gitignored from the repo for now); when the design stabilizes for public consumption, durable docs land under `docs/`.
