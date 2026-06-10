# kbbl

Operator surface for CLI coding agents. Drives one or more agent sessions from a browser — at your desk, on your phone over Tailscale, or any viewport in between. Tablet-first.

Two runtime adapters ship: **claude-code** (default) and **codex** (opt-in). The architecture treats the runtime as a plugin behind a typed interface, so new adapters can be added without touching core.

## How it works

A single Bun + Hono server hosts many sessions. Each session is a runtime-spawned subprocess; the server records per-session events to a JSONL transcript and broadcasts them over SSE to connected PWA clients. The Claude Code adapter spawns `claude` **interactively in a PTY** and configures it with **native HTTP hooks** — CC POSTs each hook event straight to a kbbl route, with no shell wrapper. The `PermissionRequest` hook (`POST /hook/permission`) parks every tool call until the operator taps Approve or Deny in the PWA — approval latency = time to tap. The remaining hooks (`/hook/tool`, `/hook/stop`, `/hook/session-{start,end}`, `/hook/notification`, `/hook/subagent-{start,stop}`) are informational and feed the transcript.

The PWA opens to a session list backed by a `/inbox` delta stream (snapshot + create/end/status/pending/activity events). In the **v2 execution model**, sessions are created programmatically by an orchestrator — oakridge-core — through the delegated `POST /sessions` contract; see [Delegated sessions](#delegated-sessions-driven-by-oakridge-core). The PWA remains the operator surface for those live sessions: the list, the transcript, and the approval gate.

### Compaction

Each session tracks token usage from runtime events. Two thresholds (`compact.soft_threshold_tokens`, `compact.hard_threshold_tokens` in `config.json`) drive different behaviors:

- **Soft threshold** — the PWA surfaces a banner offering to compact. The operator clicks to fire `POST /:sid/compact`; nothing happens automatically.
- **Hard threshold** — the server force-fires compaction itself (banner-or-not), bounded by `compact_call_timeout_seconds` and `max_consecutive_failures_before_force`.

Compaction runs the agent's `/compact` prompt, writes a handoff markdown to `data/handoffs/<sid>.md`, and ends the session with `endReason: "compacted"`. The successor session resumes from the handoff doc; the PWA renders a CompactedBanner that fetches the markdown via `GET /:sid/handoff`. The soft threshold is mutable at runtime via `PATCH /config { softThresholdTokens }` so the operator can retune without a server restart.

## Runtimes

kbbl supports two agent runtimes. Configure via `kbbl/config.json`:

| Runtime | ID | Default | Notes |
|---|---|---|---|
| Claude Code | `claude-code` | yes | Spawns `claude` interactively in a PTY; approvals + observability via native HTTP hooks. Full feature set: compaction, approval gate, yolo mode. |
| Codex | `codex` | no | Connects to the `codex` CLI app-server over a unix socket. Approval cards work; compaction not supported in v0. |

### Switching to Codex

Set `runtime.codex.enabled = true` in `kbbl/config.json` and restart the server:

```json
{
  "runtime": {
    "default": "claude-code",
    "codex": { "enabled": true, "bin": "codex" }
  }
}
```

`default` stays `claude-code` — new sessions always use CC in v0. Runtime selection via the PWA form or `POST /sessions` is a planned follow-up (see `docs/codex-followups.md` §6).

### Not in v0

- Cross-runtime resume (a CC session cannot be continued as Codex or vice versa)
- Codex compaction (`thread/compact/start` evaluation is a follow-up)
- Runtime selector in the PWA new-session form

See [`adapters/codex/README.md`](adapters/codex/README.md) for full Codex configuration, the approval mapping table, and the complete limitations list.

## Quick start

```bash
bun install
bun run build:pwa
./scripts/kbbl-start
```

Defaults to `127.0.0.1:8788` — open `http://localhost:8788/` in a browser on the same machine. From the session list, click **+ New session**, choose a directory, and start the session in the workdir of your choice.

For phone/tablet access over Tailscale, bind all interfaces:

```bash
./scripts/kbbl-start --host=0.0.0.0
```

Then open `http://<machine>:8788/` on your phone. Add to Home Screen for a full-screen standalone app. Only do this on networks where every reachable peer is trusted (Tailscale-only, or a LAN you control) — control endpoints are unauthenticated in v0.

You can still pass a workdir to `kbbl-start`; it becomes the default path shown in the **+ New session** form. If omitted, the form starts empty and the directory picker opens at the server user's home directory.

## Development

```bash
# Terminal 1: server with the agent subprocesses
./scripts/kbbl-start

# Terminal 2: Vite dev server with HMR (proxies API calls to :8788)
bun run dev:pwa
# open http://localhost:5173
```

## Running

The primary flow is `./scripts/kbbl-start` in a terminal — that's the *server*. Adding sessions happens in the PWA (or via `POST /sessions`); a second `kbbl-start` would just collide on the port.

Ctrl-C stops the server; all live agent subprocesses die with it. Ended sessions remain readable via their on-disk JSONL the next time the server starts.

### Optional: cgroup limits via systemd-run

If you want to bound resource use (shared box, or a box hosting other workloads), wrap the invocation:

```bash
systemd-run --user --scope --unit=kbbl \
  -p MemoryMax=2G -p CPUQuota=200% \
  ./scripts/kbbl-start
```

Stop with `systemctl --user stop kbbl`. Not needed on a dedicated workstation.

## Endpoints

### Sessions

- `GET /sessions` — list live sessions (add `?include=archived` to fold in on-disk JSONL)
- `POST /sessions` — create a delegated session (the C.1 contract, called by oakridge-core). Body: `{ backend, prompt, workdir?, model?, pre_authorized_tools, yolo, output_slots, callback }`, where `callback = { base_url, stage_instance_id, emit_path, status_path }`. Idempotent on `callback.stage_instance_id`: a re-POST for a still-live stage returns the existing session rather than spawning a duplicate. See [Delegated sessions](#delegated-sessions-driven-by-oakridge-core).
- `DELETE /sessions/:sid` — kill a live session (`?purge=true` also deletes the transcript)
- `GET /artifacts/:artifactId/sessions` — list sessions tagged with a given workspace-layer artifact id

### Per-session

- `GET /:sid/stream` — SSE event stream for one session
- `GET /:sid/events` — replay JSONL history (falls through to disk for archived sessions)
- `POST /:sid/input` — send operator text to the session
- `POST /:sid/approval` — Approve / Deny / Always-{tool} reply for a parked permission request
- `POST /:sid/yolo` — toggle the session's auto-approve mode
- `POST /:sid/compact` — operator-initiated compaction (the soft-threshold banner action)
- `GET /:sid/handoff` — markdown body of the session's compaction handoff (404 if never compacted)

### Inbox + config

- `GET /inbox` — SSE delta stream for the session list (snapshot + create/end/status/pending/activity)
- `POST /inbox/workspace-events` — local trusted callers push project / coordination events for SSE re-broadcast
- `GET /config` — server config snapshot for the PWA (`defaultWorkdir`, `softThresholdTokens`)
- `PATCH /config` — mutate `softThresholdTokens` at runtime (persisted back to `config.json`)
- `GET /directories?path=<absolute-path>` — list child directories for the new-session directory picker

### Runtime-private (Claude Code hooks)

All `127.0.0.1`/`::1`-only; CC POSTs the hook event JSON directly (no gate script).

- `POST /hook/permission` — `PermissionRequest` approval gate. Auto-approves under yolo or a per-tool allowlist; otherwise parks until the operator decides. Responds with `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`) + `permissionDecisionReason`.
- `POST /hook/tool` · `/hook/stop` · `/hook/session-start` · `/hook/session-end` · `/hook/notification` · `/hook/subagent-start` · `/hook/subagent-stop` — informational events recorded into the transcript (`subagent-stop` also counts subagents for billing observability).

## Layout

```text
kbbl/
├── core/                          # runtime-agnostic
│   ├── server.ts                  # entry: arg parsing, manager + app + Bun.serve wiring, signals
│   ├── config.ts                  # config.json loader + KbblConfig shape
│   ├── runtime.ts                 # AppRuntime contract that adapters implement
│   ├── runtime-interface.ts       # richer aspirational interface (sketch)
│   ├── session/
│   │   ├── session.ts             # one agent subprocess: spawn, JSONL persistence,
│   │   │                          # per-session event broadcast, YOLO / always-allow state
│   │   ├── session-manager.ts     # Map<sid, Session>, /inbox subscriptions, archived snapshots
│   │   └── compactor.ts           # soft/hard threshold tracking + runCompact lifecycle
│   ├── server/
│   │   ├── app.ts                 # Hono app factory; mounts all route groups
│   │   └── handlers/
│   │       ├── per-sid.ts         # /:sid/{stream,events,input,yolo,approval,compact}
│   │       ├── sessions.ts        # GET/POST/DELETE /sessions, /artifacts/:id/sessions
│   │       ├── directories.ts     # GET /directories?path=<absolute-path>
│   │       ├── handoff.ts         # GET /:sid/handoff (compaction markdown)
│   │       └── workspace-events.ts # POST /inbox/workspace-events ingest
│   ├── stream/
│   │   ├── sse.ts                 # streamForSession, eventsForSession, parseEventsSince
│   │   └── inbox.ts               # /inbox SSE handler
│   └── pwa/                       # React + Vite client (built to core/pwa/dist/)
├── adapters/
│   └── claude-code/               # Claude Code runtime adapter
│       ├── index.ts               # createClaudeCodeRuntime — spawns CC in a PTY, mounts hook routes
│       ├── spawn.ts               # CLI flags + settings.json / mcp-config generators + session-id resolution
│       ├── hook-route.ts          # hook handlers: /hook/permission gate + informational routes
│       ├── event-classifier.ts    # CC stdout metadata (ccSid, result usage)
│       └── models.ts              # CC model allowlist for POST /sessions validation
├── scripts/
│   └── kbbl-start                 # launcher: validates optional workdir, execs core/server.ts
├── config.json                    # compact thresholds, retention
└── data/
    ├── sessions/                  # one JSONL transcript per session (gitignored)
    └── handoffs/                  # compaction handoff markdowns, one per compacted sid
```

The `core/` ↔ `adapters/` boundary is enforced by import direction: only `core/server.ts` (the entry) imports from the adapter, to wire it in. Everything else in `core/` consumes runtimes through the `AppRuntime` interface in `core/runtime.ts`.

## Security posture

- **Network:** binds to `127.0.0.1` by default. Operator opts into wider exposure with `--host=0.0.0.0` for tailnet/phone access, and is responsible for ensuring only trusted peers can reach the port (Tailscale-only, LAN firewall, etc.). Control endpoints are unauthenticated in v0 — token-based auth is planned follow-up work.
- **Hook endpoints:** the `/hook/*` routes are filtered to `127.0.0.1`/`::1` at the route handler — only the local CC subprocess can park approval requests or post events, not a tailnet peer.
- **Path-traversal guard:** `:sid` route params are validated against a strict v4 UUID regex before any filesystem access.
- **Markdown:** assistant text is rendered with `react-markdown` + `rehype-sanitize`; no `dangerouslySetInnerHTML`, so prompt-injected HTML from web-fetched content can't execute.
- **Agent user settings (Claude Code adapter):** the server spawns CC with `--setting-sources user` so your user-level skills and slash commands are available inside the spawned subprocess. Tradeoff: user-level allowlists and permission settings in `~/.claude/settings.json` can bypass kbbl's approval gate — if you've globally approved a tool there, the permission hook won't fire for it. The operator-controlled escape hatches below (YOLO, "Always {tool}") are the intended path for short-circuiting the gate; don't rely on the gate to stop things you've already auto-approved at the user level.
- **YOLO mode and per-tool always-allow** are operator-controlled escape hatches, scoped to a single session. YOLO mode (top-bar toggle) auto-approves every permission request for the rest of the session — useful for setting an agent loose on a long task without tapping each prompt. The "Always {tool}" button on a permission card adds that tool name to a session-scoped allowlist; matching future calls auto-approve. Both reset on server restart, are emitted as visible events, and turn the gate into "see what happened" rather than "decide each call." Use them deliberately.

## Delegated sessions (driven by oakridge-core)

In the v2 execution model, kbbl is the **session service** behind oakridge-core (the
workflow orchestrator). oakridge-core owns the graph and durable state; kbbl spawns and
supervises the agent and reports back. The two are co-located and talk only over HTTP.

A `delegated_session` stage in oakridge-core:

1. `POST`s `/sessions` (the C.1 contract above) with the rendered prompt, workdir, model,
   `pre_authorized_tools`, `yolo`, declared `output_slots`, and a `callback` block
   (`base_url`, `stage_instance_id`, `emit_path`, `status_path`). kbbl spawns the agent and
   returns `201 { sid }`.
2. kbbl then fires callbacks back into oakridge-core as the session runs:
   - **artifact emit** → `POST {base_url}{emit_path}`
   - **approval needed** → `POST {base_url}/stages/{stage_instance_id}/approvals` — the
     permission gate parked a tool call. The operator resolves it on the oakridge-core
     side, which forwards the decision back to kbbl to unblock the agent.
   - **terminal status** → `POST {base_url}{status_path}` with `done`/`failed`.

   These are fire-and-forget; failures are logged, not retried (durability is a tracked
   follow-up — see `docs/known_issues.md`).

### Running it

```bash
# 1. kbbl (this server) — the session service
./scripts/kbbl-start                 # 127.0.0.1:8788

# 2. oakridge-core — the orchestrator (separate crate)
cd ../oakridge-core && cargo run     # 127.0.0.1:8790
```

Then register a workflow whose `delegated_session` stage config points
`execution_service_url` at kbbl (`http://127.0.0.1:8788`) and `callback_base_url` back at
oakridge-core (`http://127.0.0.1:8790`), and start a run. See `oakridge-core/README.md` →
*Delegated session execution (v2)*.

The callback endpoints are unauthenticated and identified only by stage-instance id — keep
both services on a trusted network (same host or Tailscale).
