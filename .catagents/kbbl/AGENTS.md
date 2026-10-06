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

## Scope authority and cutover

The Rust library evaluates pinned scope definitions without external IO.
`oakridge-dbos/` accepts commands and publications durably and owns all
workflow decisions. kbbl proxies its API and runs ACP sessions; its SQLite
ledger remains authoritative only for local sessions, turns and process
observations. The legacy `/inbox/workspace-events` event shape lacks run and
scope identity and returns 501 instead of acknowledging a discarded event.

For the Oakridge database cutover: (1) stop the service; (2) `pg_dump` to a
file nothing in this repository reads; (3) drop and recreate the Oakridge
database empty; (4) deploy the Rust CLI, DBOS backend and kbbl PWA; and
(5) admit traffic after the new stack is healthy. Do not reset kbbl's separate
SQLite ACP ledger.

## Tech stack

- **Backend**: Bun + Hono, SQLite via `bun:sqlite`
- **Frontend**: React 19 + Vite, served as static bundle from Hono in production
- **Realtime**: Server-Sent Events (Hono `streamSSE`)
- **DAG**: `reactflow@11` + `dagre` for plan-review cohort layout
- **Markdown**: `react-markdown` with `rehype-sanitize`
- **Styling**: Tailwind CSS v4 is imported by `core/pwa/styles.css`.
  Shared DAG components still use `.cohort-node__*` classes.

## Frontend file organization

App.tsx grew to ~4.3k lines because no one wrote this down. The atomic
hierarchy is in the imported React standard; kbbl-specific paths:

```text
core/pwa/
├── App.tsx                # router + top-level state ONLY (target: <300 lines)
├── main.tsx               # entry point
├── styles.css             # semantic tokens and deliberate global CSS
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

   **`core/pwa/styles.css` is exempt.** It is the single global stylesheet
   until the Tailwind migration lands, so every feature that needs a rule
   grows it — the cap would only push rules into per-component stylesheets
   the styling convention above forbids. Judge a change to it on whether
   the rules are scoped (a new pane variant belongs under its own class,
   not in a shared selector), not on the line count. Splitting it is a
   deliberate migration, not something a feature cohort does in passing.

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

## Styling

Tailwind utilities are the default layer for component styling. Semantic CSS
variables remain the token layer for colors and surfaces. Keep custom CSS
deliberately for workspace and pane layout, responsive pane behavior,
animation and pseudo-elements, and shell layout. Also retain the
`or-run-accent--*` palette in `core/pwa/styles.css`: it is a
documented Tailwind workaround whose light-theme colors are tuned for AA
contrast. Do not migrate CSS merely to maximize a Tailwind percentage.

Reuse `core/pwa/components/atoms/Button.tsx` and `Chip.tsx` for shared controls
and status labels. `core/pwa/oakridge/lib/status-tone.ts` maps Oakridge status
values to Chip tones. `FeedbackMessage` lives beside them in
`core/pwa/components/atoms/`; `StatusBadge` stays under
`core/pwa/oakridge/components/atoms/` until a non-Oakridge consumer needs it.
The convention is kbbl-scoped: `lbc-dashboard/pwa/components/atoms/` is a known
exclusion with its own vocabulary.

Choose a control's look with `variant` and `size`, not `className`. kbbl has no
class-merging step, so when `className` carries a utility for a property the
variant or size already sets (padding, font size or weight, text or border
color), the one that wins is whichever Tailwind emits later in the stylesheet,
not the one you passed. Use `className` for layout (margin, width, flex,
position) and for classes the atom does not set. When an override is genuinely
needed, mark it important (`py-2!`) so the intent survives the sort order.
Rules in `styles.css` are unlayered and beat every utility. That includes the
global `button, input, select, textarea { font: inherit }`, so a `text-*` size
or `font-*` weight on a button only applies when marked important; `Button`'s
`size` prop sets padding, not type size.

## kbbl-local overrides to shared standards

- `react.md` says “No component-render tests.” That rule does not apply to kbbl.
  Roughly a dozen component-render suites in `oakridge/__tests__/*`,
  `views/SessionListView.test.tsx`, `components/organisms/SessionRow.test.tsx`,
  SkillRail, NewSessionForm, and `molecules/RoleModelPicker` preserve
  `data-testid` assertions. Those assertions are the surface contract used to
  judge styling migrations.
- `frontend.md` says “One styling system” and forbids CSS modules,
  styled-components, and inline style objects. In kbbl, that rule is narrowed
  by the deliberate custom-CSS carve-out above because pane behavior, shell
  layout, and the contrast-tuned palette require those rules.

The imported fragments in `.catagents/standards` belong to a sibling
repository; do not edit them from this checkout.

## Styling PR checklist

- Does the change reuse an existing atom instead of hand-rolling one? Wrapping
  a hand-rolled class string in `<Button className={...}>` does not count.
- Does any `className` on an atom repeat a property its variant or size sets
  without a `!`?
- If a primitive is added, which two or more call sites justify it?
- Are all existing `data-testid` values preserved?
- Were the surface's `or-*` rules deleted, or explicitly retained with a stated reason?
- Does the PR body list visual deltas and name the screenshots taken?

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
