# oakridge

Multi-agent workspace built on jig (separate repo, agent kit) and kbbl (operator surface for CLI coding agents). The workspace layer is in design; today, oakridge is a top-level monorepo containing kbbl as its operational sub-package.

## Layout

```text
oakridge/
├── kbbl/                  # operator surface for CLI coding agents (v0, shipping)
├── legit-biz-club/        # workspace layer (v1, placeholder)
├── docs/                  # public-facing documentation (placeholder)
└── comms/                 # internal architecture memos and specs (gitignored)
```

## Sub-packages

- **kbbl** — the operator surface. Drives one or more CLI coding agents (Claude Code today; runtime-agnostic by design) from a tablet- or phone-friendly PWA over Tailscale. Standalone; works without the workspace layer. See `kbbl/README.md`.
- **legit-biz-club** — the workspace layer (multi-agent collaboration over a shared artifact). v1 build, not implemented yet. Placeholder package.

## Quick start

For the operator surface (Claude Code sessions over Tailscale):

```bash
bun install
./kbbl/scripts/kbbl-start /path/to/your/repo
```

Defaults to `127.0.0.1:8788`. See `kbbl/README.md` for tablet/phone exposure, dev mode, and security posture.

## Development

```bash
bun install                # installs deps across all sub-packages
bun run typecheck          # typecheck across the repo
```

## Trajectory

The architectural direction (multi-agent collaboration over a shared artifact, runtime-agnostic operator surface, jig as the agent substrate) lives in internal architecture memos that are not currently checked in. Public-facing docs land under `docs/` when the design stabilizes; until then, `docs/` is a placeholder.
