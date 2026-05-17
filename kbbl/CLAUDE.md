# CLAUDE.md

Conventions for `kbbl` — the operator surface for CLI coding agents. Reload every session; update in the same commit as any architectural change.

## What this is

Bun + Hono backend on `:8788` that serves a React PWA, manages Claude Code sub-sessions, and exposes a review/dispatch layer for plans and briefs. Session-shaped UX (live transcripts, inbox, per-sid streams). LBC's project-shaped dashboard lives separately in `../lbc-dashboard` — do not conflate.

## Tech stack

- **Backend**: Bun + Hono, SQLite via `bun:sqlite`
- **Frontend**: React 19 + Vite, served as static bundle from Hono in production
- **Realtime**: Server-Sent Events (Hono `streamSSE`)
- **DAG**: `reactflow@11` + `dagre` for plan-review cohort layout
- **Markdown**: `react-markdown` with `rehype-sanitize`
- **No state library** — local React state + small custom hooks
- **Styling**: currently inline `style={{}}` props + `pwa/styles.css`. No Tailwind. Don't add a styling system without scoping it first.

## Frontend file organization (Atomic Design)

This is the non-negotiable part. App.tsx grew to ~4.3k lines because no one wrote it down.

```text
core/pwa/
├── App.tsx                # router + top-level state ONLY (target: <300 lines)
├── main.tsx               # entry point
├── styles.css             # global tokens
├── hooks/                 # one hook per file: useInbox, useHashRoute, useTheme, useServerConfig, etc.
├── views/                 # full-route components: SessionListView, SessionView, TaskView
├── components/
│   ├── atoms/             # StatusPill, Spinner, IconButton
│   ├── molecules/         # InboxRow, ThreadCard, ProjectRow
│   └── organisms/         # InboxList, NewSessionForm, Sidebar
└── review/
    ├── plan/              # PlanReviewView and its locals (DagEditor, CohortNode, CohortPanel, ApproveModal, RejectModal)
    ├── brief/             # BriefReviewView and its locals (StructuredDocEditor)
    └── shared/            # ThreadView, ThreadSidebar, ModeToggle, useArtifactStream, AtomCommentAffordance
```

## Hard rules

1. **App.tsx is the router/shell.** It composes hooks and chooses which `<View>` to render based on hash route. It does NOT define `useInbox`, `SessionListView`, helpers, or any non-trivial subcomponent inline. New top-level features add a new view in `views/`.

2. **File size soft cap: 300 lines.** When a component crosses 300 lines, split before adding more. When a file crosses 500 lines, splitting is mandatory before the PR ships. App.tsx and BriefReviewView are grandfathered but must shrink.

3. **One hook per file in `hooks/`.** Each owns its `useEffect` lifecycle, abort handling, and refresh key. Don't define hooks inside view components.

4. **One view per route.** `#plan/<id>` → `views/PlanReviewView.tsx`, `#brief/<id>` → `views/BriefReviewView.tsx`, etc. App.tsx never inlines route bodies.

5. **External library CSS must be imported at the consumer.** Forgetting `import "reactflow/dist/style.css"` in `DagEditor.tsx` is what broke cohort clicks in May 2026 — nodes rendered as stacked unstyled divs with no pointer-events. When pulling in a UI lib (reactflow, react-day-picker, etc.), the CSS import goes in the same file as the import that uses it, with a comment explaining why.

6. **Inline styles are tolerated, not encouraged.** Until a styling system is chosen, keep inline `style={{}}` as the consistent pattern. Don't mix in CSS Modules or styled-components ad-hoc. Don't add `className` strings against `styles.css` for new components — extend the inline pattern for consistency.

7. **No vestigial route names.** When a backend integration is ripped out, rename the routes it touched. The `/safir-stream` → `/artifact-stream` rename in this same commit is the cautionary tale.

## Realtime / SSE conventions

- Every `streamSSE` handler MUST `await stream.write(": ready\n\n")` early — before any code path that can block waiting for events. Place it right after the subscribe call and before replay / idle waits. Without it, the EventSource sits on an empty body for up to 15s (until the heartbeat) and the browser's network indicator stays "loading."
- Heartbeat at 15s with `: ping\n\n` is standard. Don't tune per-route.
- Client-side: SSE lifecycle goes in a `hooks/use<Stream>.ts`. View components consume, they don't `new EventSource` directly. `useArtifactStream` (in `review/shared/`) is the model.
- Client must close the EventSource in the effect cleanup. A `useRef` over `cancelled` per the React docs pattern is fine.

## Code conventions

- **TypeScript strict.** No `any`. Prefer `interface` for object shapes, `type` for unions / discriminated tagged types.
- **Functional pipelines** for derived state and list rendering — `map` / `filter` / `reduce`. Imperative `for` loops are for actually-imperative work (event subscription, polling).
- **No `useMemo` / `useCallback` cargo-culting.** Use them when a downstream `useEffect` or memoized child depends on referential stability. Skip them for cheap pure expressions.
- **Hash routing only.** No `react-router` until the route count justifies it.

## Performance discipline

When the UI feels laggy:

1. **Check the browser, not the server.** Server-side endpoints all respond in <1ms on localhost. Lag is almost always React re-render storms, missing CSS, or a closure being recreated every render and breaking memoization downstream.
2. **Open DevTools → Performance → record.** 30 seconds of profiling beats 30 minutes of guessing.
3. **Check for dead requests.** `/safir/tasks` and `/safir/permission-profiles` were 404'ing on every SessionListView mount because safir was ripped out but the fetches stayed. Grep for the removed service's routes when ripping things out.

## Commands

```bash
bun run --filter kbbl dev          # backend on :8788 (no PWA hot-reload)
bun run --filter kbbl dev:pwa      # vite dev server :5173 (proxies API to :8788)
bun run --filter kbbl build:pwa    # static bundle to core/pwa/dist/
bun run --filter kbbl start        # production: build PWA + serve from Hono
bun run --filter kbbl test         # backend tests
bun run --filter kbbl test:pwa     # frontend tests (vitest)
bun run --filter kbbl test:all     # both
```

Production mode is what `kbbl-start` runs. The PWA is rebuilt on every `bun run start`, served from `core/pwa/dist/`.

## Configuration

- `KBBL_PORT` — defaults to `8788`. Followed by both Hono and Vite's dev proxy.
- `--workdir=<path>` — required CLI arg to `core/server.ts`. Validated to be inside a git repo.
- `--host=<addr>` — bind host, defaults to `127.0.0.1`. Use `0.0.0.0` for Tailscale access.
- `--config=<path>` — optional override for `config.json` location.

## What's NOT in this project (yet)

- **Tailwind / CSS-in-JS** — explicit choice, see styling above. Don't introduce without a migration plan for the existing inline styles.
- **React Router** — hash routing is enough for the current view count.
- **Storybook / component sandbox** — when atoms/molecules library grows beyond ~15 entries, revisit.
- **GraphQL** — REST + SSE handles everything currently.
