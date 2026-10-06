# oakridge

Oakridge runs pinned scope definitions through a Rust compiler and evaluator.
`oakridge-dbos/` owns durable ingress, mutations, effect dispatch, recovery and
read projections. `kbbl/` provides the operator PWA and ACP session adapter;
its SQLite ledger owns only adapter-local sessions, turns and process
observations. It does not decide workflow acceptance, retries, stage completion
or parent failure. `workflow-config/` holds example bundles and prompts.

The workspace layer (`legit-biz-club/`) remains an independent library, and
`lbc-dashboard/` remains its read-only dashboard.

Sub-packages each carry their own AGENTS.md / CLAUDE.md with stack-specific
conventions. This root file sets the universal floor only.

## Layout

- **workflow-core/** — Rust compiler, evaluator and CLI for pinned scope definitions.
- **oakridge-dbos/** — Bun + DBOS durable scope authority and read projections.
- **workflow-config/** — example scope bundles and prompts.
- **kbbl/** — Bun + Hono + React operator PWA and ACP session adapter.
- **lbc-dashboard/** — Bun + Hono + React + Tailwind. Read-only dashboard
  for legit-biz-club study runs.
- **legit-biz-club/** — Python. Workspace layer (multi-agent collaboration
  over a shared artifact). Library, no CLI.

Workspace-level commands:

```bash
bun install                # installs workspace Bun dependencies
bun run typecheck          # typecheck across the repo
```

Python sub-packages are independent uv projects — see each package's own
AGENTS.md for its commands.

## Database cutover

For a reset to the scope authority, perform these steps in order:

1. Stop the Oakridge service.
2. Run `pg_dump` to a file that nothing in this repository reads.
3. Drop and recreate the Oakridge database empty.
4. Deploy the new stack, including the Rust CLI, DBOS backend and kbbl PWA.
5. Admit traffic only after the new stack is healthy.

The kbbl SQLite ACP ledger is separate and is not part of this reset.

@./standards/core.md

## Environment

@./standards/gated-review.md
