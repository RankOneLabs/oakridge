# oakridge

Multi-agent workspace built on jig (separate repo, agent kit) and kbbl (operator surface for CLI coding agents).

This repo is **mid-restructure**. Until the workspace layer ships, oakridge is a top-level monorepo containing kbbl as its operational sub-package.

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

The architectural direction (multi-agent collaboration over a shared artifact, runtime-agnostic operator surface, jig as the agent substrate) is captured in internal architecture memos that are not currently checked in. When the design stabilizes for public consumption, durable docs will land under `docs/`. Until then, `docs/` is a placeholder.
