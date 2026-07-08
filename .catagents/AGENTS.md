# oakridge

Multi-agent workspace built on jig (separate repo, agent kit) and kbbl
(operator surface for CLI coding agents). The workspace layer
(legit-biz-club) is v1 complete; kbbl ships standalone today.

Sub-packages each carry their own AGENTS.md / CLAUDE.md with stack-specific
conventions. This root file sets the universal floor only.

## Layout

- **kbbl/** — Bun + Hono + React PWA. Operator surface for CLI coding agents.
- **lbc-dashboard/** — Bun + Hono + React + Tailwind. Read-only dashboard
  for legit-biz-club study runs.
- **legit-biz-club/** — Python. Workspace layer (multi-agent collaboration
  over a shared artifact). Library, no CLI.

Workspace-level commands:

```bash
bun install                # installs deps across kbbl + lbc-dashboard
bun run typecheck          # typecheck across the repo
```

Python sub-packages are independent uv projects — see each package's own
AGENTS.md for its commands.

@./standards/core.md

## Environment

@./standards/gated-review.md
