# lbc-dashboard

Frontend conventions for `lbc-dashboard`.

## What this is

Localhost dashboard for `legit-biz-club` study runs. Read-only over
`legit-biz-club/.run/<ts>/<target>/<condition>/` cell sidecars.
Project-shaped UX (ensemble + artifact + per-commit history + eval
scores), separate from kbbl's session-shaped surface.

## Tech stack

- **Backend**: Bun + Hono (matches kbbl)
- **Frontend**: React 19 + Vite (matches kbbl)
- **Styling**: Tailwind CSS v4 (zero-config, `@tailwindcss/vite` plugin).
  The `prose` plugin (`@tailwindcss/typography`) is enabled for rendering
  markdown artifacts.
- **Markdown**: `react-markdown`

## Component organization

Atomic hierarchy is in the imported react standard. lbc-dashboard-specific
paths:

- `pwa/components/atoms/` — `StatusPill`, `EmptyMessage`, `TabButton`
- `pwa/components/molecules/` — `CellRow`, `EventRow`, `CommitCard`, `ScoreRow`
- `pwa/components/organisms/` — `CellList`, `CellPanel`
- `pwa/App.tsx` — top-level orchestrator (not under `components/`);
  wires hooks + state, renders organisms

Pages live in `App.tsx`; there's no routing yet (single-pane layout).
When routing arrives, page components go into `pwa/pages/`.

## Hooks + data layer

- `pwa/hooks/` — small data-fetching hooks (`useCells`, `useCellEvents`,
  `useArtifact`, etc.). One hook per resource. Each owns its `useEffect`
  lifecycle, abort handling, and refresh key.
- `pwa/lib/types.ts` — shared TypeScript types mirroring backend response
  shapes. Hand-maintained; no codegen yet. Keep in sync with `src/store.ts`.

## No write surface in v0

The dashboard reads `.run/` sidecars and serves them. Operators trigger
cells from the terminal. Adding a write side (start cell, cancel run,
edit brief) is a real architectural step that warrants a separate PR.

## What's NOT in this project (yet)

These appear in some other frontend repos' conventions but don't apply
here yet:

- **Framer Motion** — no animations needed for a dev tool.
- **React Hook Form + Zod** — no forms yet. Add when there are.
- **Next.js** — kbbl is plain Vite + React for serving a static bundle
  from Hono; lbc-dashboard mirrors that. Stay on Vite + React unless
  there's a strong reason.
- **`lib/constants.ts` for centralized copy** — there's barely any copy
  in the dashboard. Add when the volume justifies it.

## Commands

```bash
bun run --filter lbc-dashboard dev          # backend, :8765
bun run --filter lbc-dashboard dev:pwa      # frontend hot-reload, :5173 (proxies /api/*)
bun run --filter lbc-dashboard build:pwa    # static bundle to pwa/dist/
bun run --filter lbc-dashboard start        # serve built bundle from Hono on :8765
bun run --filter lbc-dashboard test         # bun test for backend
bunx tsc --noEmit                            # full-project typecheck (from oakridge root)
```

## Configuration

- `LBC_DASHBOARD_PORT` — defaults to `8765`
- `LBC_RUN_ROOT` — path to legit-biz-club's run output dir. Defaults to
  the sibling `../legit-biz-club/.run/`.

@../standards/core.md
@../standards/typescript.md
@../standards/backend.md
@../standards/frontend.md
@../standards/react.md
