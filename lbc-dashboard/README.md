# lbc-dashboard

Localhost dashboard for `legit-biz-club` study runs. Read-only, project-shaped (ensemble + artifact + per-commit history + eval scores). Separate workspace from `kbbl` because lbc's UX is project-shaped while kbbl's is session-shaped — they're different operator surfaces and forcing them into one UI would warp both.

The dashboard is the v0 of the lbc operator surface. Future iterations grow into a richer SPA (multi-cell comparison, n-sweep aggregation, eval-score deltas) on the same Bun + Hono + React stack.

## What it does

- Discovers cells under `legit-biz-club/.run/<ts>/<target>/<condition>/`
- Tails each cell's `events.jsonl` over SSE so the page updates as the harness runs
- Renders the current artifact (markdown), per-commit snapshots, and the workspace-event timeline
- Status pill: `active` / `ended` (heuristic on the events.jsonl tail)

The Python harness writes everything to disk; the dashboard is purely a reader. There is no write surface — operators trigger cells from the terminal.

## Layout

```text
lbc-dashboard/
├── server.ts            Hono entry — read-only API + serves the built PWA
├── src/
│   ├── store.ts         cell discovery, event tailing, artifact + commit reads
│   └── store.test.ts
├── pwa/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx          orchestrator — composes CellList + CellPanel
│   ├── components/      Atomic Design (atoms / molecules / organisms)
│   ├── hooks/           one hook per resource
│   ├── lib/types.ts     shared API response types
│   └── vite.config.ts
└── package.json
```

## Workflow

```bash
# Terminal 1 — dashboard backend (long-running)
bun run --filter lbc-dashboard dev

# Terminal 2 — frontend dev server (Vite hot-reload, optional)
bun run --filter lbc-dashboard dev:pwa

# Terminal 3 (any time, any number) — run a cell
cd legit-biz-club && uv run python scripts/run_one_project.py
```

For dev iteration, hit Vite at `http://localhost:5173` (proxies `/api/*` to Hono on `:8765`). For prod-shaped runs, build then start:

```bash
bun run --filter lbc-dashboard build:pwa
bun run --filter lbc-dashboard start
# http://localhost:8765
```

Cell URLs are stable (`#cell=<run_ts>__<target>__<condition>`) so refreshes preserve position and links work.

## Configuration

- `LBC_DASHBOARD_PORT` — defaults to `8765`
- `LBC_RUN_ROOT` — path to legit-biz-club's run output dir. Defaults to the sibling `../legit-biz-club/.run/`. Override for unusual layouts.

## What's deliberately NOT in v0

- **No write side** — no triggering or canceling runs from the UI.
- **No multi-cell comparison view** — single-cell drilldown only. Cross-condition deltas + n-sweep aggregation is the next iteration.
- **No commit diff viewer** — per-commit content shown standalone, not as an inline diff.
- **No eval-score charts** — scores aren't yet surfaced (the harness writes them to `CellResult` but not to a sidecar file the dashboard can read; a small lbc-side change would expose them).
- **No auth** — localhost-only.
