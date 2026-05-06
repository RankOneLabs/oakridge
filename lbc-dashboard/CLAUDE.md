# CLAUDE.md

Frontend conventions for `lbc-dashboard`. Reload every session; update in the same commit as any architectural change.

## What this is

Localhost dashboard for `legit-biz-club` study runs. Read-only over `legit-biz-club/.run/<ts>/<target>/<condition>/` cell sidecars. Project-shaped UX (ensemble + artifact + per-commit history + eval scores), separate from kbbl's session-shaped surface.

## Tech stack

- **Backend**: Bun + Hono (matches kbbl)
- **Frontend**: React 19 + Vite (matches kbbl)
- **Styling**: Tailwind CSS v4 (zero-config, `@tailwindcss/vite` plugin)
- **Markdown**: `react-markdown` (matches kbbl)
- **No state library** — local React state + small custom hooks. Add Zustand or similar only when the prop-drilling pain shows up.

## Component organization (Atomic Design)

Components live under `pwa/components/` and follow [Atomic Design](https://atomicdesign.bradfrost.com/chapter-2/):

- `pwa/components/atoms/` — irreducible UI elements: `StatusPill`, `EmptyMessage`, `TabButton`
- `pwa/components/molecules/` — small groups of atoms: `CellRow`, `EventRow`, `CommitCard`, `ScoreRow`
- `pwa/components/organisms/` — complex sections: `CellList`, `CellPanel`
- `pwa/App.tsx` — top-level orchestrator (not under `components/`); wires hooks + state, renders organisms.

Pages live in `App.tsx`; we don't have routing yet (single-pane layout). When routing arrives, page components go into `pwa/pages/`.

## Hooks + data layer

- `pwa/hooks/` — small data-fetching hooks (`useCells`, `useCellEvents`, `useArtifact`, etc.). One hook per resource. Each hook owns its `useEffect` lifecycle, abort handling, and refresh key.
- `pwa/lib/types.ts` — shared TypeScript types mirroring backend response shapes. Hand-maintained; no codegen yet. Keep in sync with `src/store.ts`.

## Styling

Tailwind utility classes only — no inline `style={{...}}`, no separate per-component CSS files. Custom theme tokens (if needed later) go into `pwa/styles.css` under a `@theme` block.

The `prose` plugin (`@tailwindcss/typography`) is enabled for rendering markdown artifacts.

## Code conventions

**Functional pipelines for data transforms.** Use `map` / `filter` / `reduce` — no imperative loops (`for`, `forEach`, `while`) for rendering lists, processing API responses, building derived state, or any other data transform. Imperative loops are reserved for actually-imperative work (subscribing to events, polling timers).

**Strict TypeScript.** `noUnusedLocals`, `noUnusedParameters`, `strict: true` from the root `tsconfig.json`. Prefer `interface` for object shapes, `type` for unions / function shapes / discriminated tagged types.

**No write surface in v0.** The dashboard reads `.run/` sidecars and serves them. Operators trigger cells from the terminal. Adding a write side (start cell, cancel run, edit brief) is a real architectural step that warrants a separate PR.

## What's NOT in this project (yet)

These appear in `shldotcom`'s frontend conventions but don't apply here yet:

- **Framer Motion** — no animations needed for a dev tool. Add if a real SPA-shaped iteration calls for transitions.
- **React Hook Form + Zod** — no forms in lbc-dashboard yet. Add when there are.
- **Next.js** — kbbl is plain Vite + React for serving a static bundle from Hono; lbc-dashboard mirrors that. Switching to Next would mean a different build pipeline than kbbl. Stay on Vite + React unless there's a strong reason.
- **`lib/constants.ts` for centralized copy** — there's barely any copy in the dashboard. Add when the volume justifies it.

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
- `LBC_RUN_ROOT` — path to legit-biz-club's run output dir. Defaults to the sibling `../legit-biz-club/.run/`.
