# oakridge

Oakridge runs pinned workflow definitions through a Rust compiler and evaluator.
`oakridge-dbos/` owns durable ingress, mutations, effect dispatch, recovery and
read projections. `kbbl/` provides the operator PWA and ACP session adapter;
its SQLite ledger owns only adapter-local sessions, turns and process
observations. It does not decide workflow acceptance, retries, stage completion
or parent failure. `workflow-config/` holds example bundles and prompts.

Sub-packages each carry their own AGENTS.md / CLAUDE.md with stack-specific
conventions. This root file sets the universal floor only.

## Layout

- **workflow-core/** — Rust model, compiler and evaluator for pinned workflow definitions, loaded as WASM.
- **oakridge-dbos/** — Bun + DBOS durable run authority and read projections.
- **workflow-config/** — the development workflow, samples and prompts.
- **kbbl/** — Bun + Hono + React operator PWA and ACP session adapter.

Workspace-level commands:

```bash
bun install                # installs workspace Bun dependencies
bun run typecheck          # typecheck across the repo
```

Python sub-packages are independent uv projects — see each package's own
AGENTS.md for its commands.

## Database cutover

For a reset of the Oakridge database, perform these steps in order:

1. Stop the Oakridge service.
2. Run `pg_dump` to a file that nothing in this repository reads.
3. Drop and recreate the Oakridge database empty.
4. Deploy the new stack, including the core WASM, DBOS backend and kbbl PWA.
5. Admit traffic only after the new stack is healthy.

The kbbl SQLite ACP ledger is separate and is not part of this reset.

@./standards/core.md

## Environment

@./standards/gated-review.md
