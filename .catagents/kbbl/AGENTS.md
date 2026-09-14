# kbbl

Conventions for `kbbl` — the operator surface for CLI coding agents.

## What this is

Bun + Hono backend on `:8788` that serves a React PWA and manages Claude Code
and Codex sessions through ACP. Workflow orchestration belongs to
`oakridge-dbos/`; kbbl hosts its v2 UI and same-origin proxy. The old kbbl
v1 Projects UI and review/dispatch backend have been removed. V2 uses the
DBOS project registry at `/oakridge/api/projects`; the separate legacy
kbbl `/projects` registry and shared v2 DAG/collaboration components remain.
Session-shaped UX (live transcripts, inbox, per-sid streams). LBC's
project-shaped dashboard lives separately in `../lbc-dashboard` — do not
conflate.

## Tech stack

- **Backend**: Bun + Hono, SQLite via `bun:sqlite`
- **Frontend**: React 19 + Vite, served as static bundle from Hono in production
- **Realtime**: Server-Sent Events (Hono `streamSSE`)
- **DAG**: `reactflow@11` + `dagre` for plan-review cohort layout
- **Markdown**: `react-markdown` with `rehype-sanitize`
- **Styling**: Tailwind CSS v4 is installed through Vite and imported by
  `core/pwa/styles.css`. Existing named classes and inline styles remain;
  preserve the surrounding component vocabulary when maintaining them.
  Shared DAG components still use `.cohort-node__*` classes.

## Frontend file organization

App.tsx grew to ~4.3k lines because no one wrote this down. The atomic
hierarchy is in the imported React standard; kbbl-specific paths:

```text
core/pwa/
├── App.tsx                # router + top-level state ONLY (target: <300 lines)
├── main.tsx               # entry point
├── styles.css             # global tokens (legacy until Tailwind migration)
├── hooks/                 # one hook per file
├── views/                 # full-route components per hash route
├── components/
│   ├── atoms/
│   ├── molecules/
│   └── organisms/
├── oakridge/             # v2 workflow views, components, hooks, selectors
└── review/               # shared v2 building blocks, not v1 routes
    ├── plan/              # DagEditor, CohortNode, shared DAG types
    └── shared/            # ThreadSidebar, ThreadView, atom comment affordance
```

## Hard rules

1. **App.tsx is the router/shell.** Composes hooks and chooses which
   `<View>` to render based on hash route. It does NOT define `useInbox`,
   `SessionListView`, helpers, or any non-trivial subcomponent inline. New
   top-level features add a new view in `views/`.

2. **File size soft cap: 300 lines.** When a component crosses 300 lines,
   split before adding more. When a file crosses 500 lines, splitting is
   mandatory before the PR ships. Existing oversized files must shrink
   when changed; removed v1 views are not precedents.

3. **One hook per file in `hooks/`.** Each owns its `useEffect` lifecycle,
   abort handling, and refresh key. Don't define hooks inside view
   components.

4. **One view per route.** Session routes use `views/`; v2 workflow routes
   are composed under `oakridge/`. App.tsx never inlines route bodies.
   Do not restore retired `#plan`, `#brief`, `#cohort`, `#repo`, or `#epic` routes.

5. **External library CSS must be imported at the consumer.** Forgetting
   `import "reactflow/dist/style.css"` in `DagEditor.tsx` is what broke
   cohort clicks in May 2026 — nodes rendered as stacked unstyled divs
   with no pointer-events. When pulling in a UI lib (reactflow,
   react-day-picker, etc.), the CSS import goes in the same file as the
   import that uses it, with a comment explaining why.

6. **No vestigial route names.** When a backend integration is ripped out,
   rename the routes it touched so the URL surface reflects what's actually
   served.

## Realtime / SSE conventions

- Every `streamSSE` handler MUST `await stream.write(": ready\n\n")` early
  — before any code path that can block waiting for events. Place it right
  after the subscribe call and before replay / idle waits. Without it, the
  EventSource sits on an empty body for up to 15s (until the heartbeat)
  and the browser's network indicator stays "loading."
- Heartbeat at 15s with `: ping\n\n` is standard. Don't tune per-route.
- Client-side: SSE lifecycle goes in a `hooks/use<Stream>.ts`. View
  components consume, they don't `new EventSource` directly.
  Follow `hooks/useAcpSession.ts` and the Oakridge stream hooks; the v1
  artifact stream and its hook have been removed.
- Client must close the EventSource in the effect cleanup. A `useRef` over
  `cancelled` per the React docs pattern is fine.

## Performance discipline

When the UI feels laggy:

1. **Check the browser, not the server.** Server-side endpoints all
   respond in <1ms on localhost. Lag is almost always React re-render
   storms, missing CSS, or a closure being recreated every render and
   breaking memoization downstream.
2. **Open DevTools → Performance → record.** 30 seconds of profiling
   beats 30 minutes of guessing.
3. **Check for dead requests.** When ripping out a backend integration,
   grep for the removed service's routes — leftover fetches show up as
   404s on every mount and bury real signal.

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

Production mode is what `kbbl-start` runs. The PWA is rebuilt on every
`bun run start`, served from `core/pwa/dist/`.

## Configuration

- `KBBL_PORT` — defaults to `8788`. Followed by both Hono and Vite's dev proxy.
- `--workdir=<path>` — optional CLI arg to `core/server.ts`, supplying the
  new-session form's default directory.
- `--host=<addr>` — bind host, defaults to `127.0.0.1`. Use `0.0.0.0` for
  Tailscale access.
- `--config=<path>` — optional override for `config.json` location.
- `acp.default_agent` and `acp.agents` configure active agent profiles.
  Legacy runtime settings do not configure the removed adapters.

## What's NOT in this project (yet)

- **React Router** — hash routing is enough for the current view count.
- **Storybook / component sandbox** — when atoms/molecules library grows
  beyond ~15 entries, revisit.
- **GraphQL** — REST + SSE handles everything currently.

@../standards/core.md
@../standards/typescript.md
@../standards/backend.md
@../standards/frontend.md
@../standards/react.md
