# lbc-dashboard

Localhost dashboard for `legit-biz-club` study runs. Project-shaped (ensemble + artifact + per-commit history + eval scores). Separate workspace from `kbbl` because lbc's UX is project-shaped while kbbl's is session-shaped — they're different operator surfaces and forcing them into one UI would warp both.

The dashboard is the v0 of the lbc operator surface. Future iterations grow into a richer SPA (multi-cell comparison, n-sweep aggregation, eval-score deltas) on the same Bun + Hono + React stack.

## What it does

- Discovers cells under `legit-biz-club/.run/<ts>/<task>/<condition>/`
- Tails each cell's `events.jsonl` over SSE so the page updates as the harness runs
- Renders the current artifact (markdown), per-commit snapshots, and the workspace-event timeline
- Eval scores tab: when `eval_scores.json` is present for the cell, shows per-dimension scores (with a value bar) and the average
- Status pill: `active` / `ended` / `failed` / `cancelled` / `unknown` (derived from the events.jsonl tail and cache state)
- Run-detail panel renders **typed, model-aware event cards** (proposal applies, rounds, convergence, escalation, picks, termination, failures) instead of raw JSON, with the raw payload available behind a per-card disclosure; the detail header shows **model chips** (`Readable Name · agent-id suffix`) derived from the run's model pool
- **Rounds tab** groups a cell's incremental updates, consensus rounds, escalation, and the final pick/apply into a readable timeline. Current logs do not persist full per-round proposal bodies, so the tab shows that rounds happened and which proposal was finally applied — not every round's full output (an inline note states this)

The Python harness writes everything to disk. The dashboard also has a write surface: operators can configure and launch a study run from the UI (POST /api/runs), monitor it live, and cancel it (DELETE /api/runs/:runId) — all without touching the terminal. The run registry is in-memory; a dashboard restart forgets in-flight run status (cells still appear via disk discovery once the harness starts writing).

The dashboard can also **clean up completed run output** without going through the filesystem: **archive** (hide a cell from the default list), **restore**, and **permanent delete** (remove the cell directory from `.run/`). Archive metadata is dashboard-owned (stored in `archived-cells.json` under the dashboard data root) — archiving never touches the harness's `.run/` output, so it is always allowed and fully reversible. Permanent delete is destructive and gated on a server-computed `cleanable` flag (see below); the UI requires a confirmation that names the task, condition, and run timestamp before deleting.

### Cleanup API

```http
GET    /api/cells?archived=include|only   # default: non-archived only; include: all; only: archived
POST   /api/cells/:cellId/archive          # add to archive index → updated CellSummary (always allowed)
DELETE /api/cells/:cellId/archive          # restore → updated CellSummary (or { ok: true } if gone)
DELETE /api/cells/:cellId                  # permanent delete, gated on `cleanable` (409 if not)
```

Every `CellSummary` carries two server-computed booleans the UI must not re-derive:

- `archived` — present in the dashboard-owned archive index.
- `cleanable` — safe to permanently delete. True when the cell has `status === "ended"`, **or** when there is no live run for the cell and its last activity has been idle longer than `STALE_MS` (5 minutes) — where last activity is the `events.jsonl` mtime, or the cell directory's mtime if it hasn't emitted events yet. The staleness branch lets operators reclaim crashed/abandoned runs that never emitted a terminal event; a non-cleanable delete returns `409 { error: "Run still in progress" }`. Delete removes only `<run_ts>/<task>/<condition>` — sibling conditions and `run-spec.json` are left untouched.

Note: the archive/delete gate applies to **delete only**. Archive and restore are index-only and allowed on any cell, including active ones — hiding a still-running cell from the default list is safe because no harness output is touched.

## Layout

```text
lbc-dashboard/
├── server.ts            Hono entry — API (read + launch) + serves the built PWA
├── src/
│   ├── store.ts         cell discovery, event tailing, artifact + commit reads
│   ├── runs.ts          run registry + subprocess launcher seam
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

### Launching a run from the UI

1. Open the dashboard at `http://localhost:8765`.
2. Use the Launch panel to select a task, condition, and model pool.
3. Click **Launch** — the dashboard POSTs to `/api/runs`, writes `run-spec.json` to `<run_root>/<run_ts>/`, and spawns `uv run python -m legit_biz_club.run --spec <run_root>/<run_ts>/run-spec.json --output-dir <run_root>/<run_ts>/`.
4. The response includes `cell_id`; the PWA navigates directly to the cell's live view.
5. To cancel: use the **Cancel** button or DELETE `/api/runs/:runId`.

The run registry is in-memory. A dashboard restart forgets in-flight run status; cells already on disk continue to surface via disk discovery.

### Terminal-only flow (unchanged)

```bash
cd legit-biz-club && uv run python -m legit_biz_club.run --spec <path-to-run-spec.json> --output-dir <path-to-output-dir>
```

### Dev servers

There is no single command that serves a freshly-edited PWA — use two terminals:

```bash
# Terminal 1 — Hono backend (API + commits + SSE)
bun run --filter lbc-dashboard dev

# Terminal 2 — Vite PWA dev server (hot-reload; proxies /api/* to :8765)
bun run --filter lbc-dashboard dev:pwa
# → http://localhost:5173
```

To refresh the bundle served by the Hono process:

```bash
bun run --filter lbc-dashboard build:pwa
bun run --filter lbc-dashboard start
# → http://localhost:8765
```

Cell URLs are stable. The hash carries a ``cell`` key whose value is the cell_id format the API returns — three URI-encoded path segments joined with `:`, e.g. `#cell=2026-05-06T18-35-10-831380Z%3Aprose_substrate_thesis%3Aensemble_multi_round_n3` (the `:` between segments encodes to `%3A` in the URL). Refreshes preserve position and links work.

## Configuration

- `LBC_DASHBOARD_PORT` — defaults to `8765`
- `LBC_RUN_ROOT` — path to legit-biz-club's run output dir. Defaults to the sibling `../legit-biz-club/.run/`. Override for unusual layouts.

## What's deliberately NOT in v0

- **No multi-cell comparison view** — single-cell drilldown only. Cross-condition deltas + n-sweep aggregation is the next iteration.
- **No commit diff viewer** — per-commit content shown standalone, not as an inline diff.
- **No eval-score charts** — single-cell tab renders scores as a table; cross-cell aggregation / charting comes with the multi-cell view.
- **No auth** — localhost-only.
