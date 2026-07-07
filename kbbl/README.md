# kbbl

Operator surface for CLI coding agents. Drives one or more agent sessions from a browser — at your desk, on your phone over Tailscale, or any viewport in between. Tablet-first.

Two runtime adapters ship: **claude-code** (default) and **codex** (opt-in). The architecture treats the runtime as a plugin behind a typed interface, so new adapters can be added without touching core.

## How it works

A single Bun + Hono server hosts many sessions. Each session is a runtime-spawned subprocess; the server pipes its NDJSON events through a per-session JSONL transcript and broadcasts them over SSE to connected PWA clients. A PreToolUse hook (currently `adapters/claude-code/scripts/gate.sh`) routes every tool call through the server, which parks the decision until the operator taps Approve or Deny in the PWA — approval latency = time to tap.

The PWA opens to a session list backed by a `/inbox` delta stream (snapshot + create/end/status/pending/activity events). New sessions are created from the list view, not by launching another server. Ended sessions linger on disk and can be resumed from their row in the list — the resumed session is a new fork that inherits the parent's context.

Specs create Epics with split model selections. Planner stages (`spec_analyzer`, `plan_writer`, `brief_writer`, `assessor`) use `planner_model_selection`; `build` uses `worker_model_selection`. The spec modal reads `/config` runtime descriptors so each role can pick its own runtime/model pair.

### Compaction

Each session tracks token usage from runtime events. Two thresholds (`compact.soft_threshold_tokens`, `compact.hard_threshold_tokens` in `config.json`) drive different behaviors:

- **Soft threshold** — the PWA surfaces a banner offering to compact. The operator clicks to fire `POST /:sid/compact`; nothing happens automatically.
- **Hard threshold** — the server force-fires compaction itself (banner-or-not), bounded by `compact_call_timeout_seconds` and `max_consecutive_failures_before_force`.

Compaction runs the agent's `/compact` prompt, writes a handoff markdown to `data/handoffs/<sid>.md`, and ends the session with `endReason: "compacted"`. The successor session resumes from the handoff doc; the PWA renders a CompactedBanner that fetches the markdown via `GET /:sid/handoff`. The soft threshold is mutable at runtime via `PATCH /config { softThresholdTokens }` so the operator can retune without a server restart.

## Runtimes

kbbl supports two agent runtimes. Configure via `kbbl/config.json`:

> `kbbl/config.json` is git-ignored per-deploy local config. Copy the checked-in
> `kbbl/config.example.json` to `kbbl/config.json` and edit it locally; a missing
> `config.json` falls back to built-in schema defaults.

| Runtime | ID | Default | Notes |
|---|---|---|---|
| Claude Code | `claude-code` | yes | Drives CC via `--output-format stream-json`. Full feature set: compaction, approval hook, yolo mode. |
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

`default` stays `claude-code`. Direct sessions can be launched from the PWA, and
trusted local callers can choose a runtime with `POST /sessions` by passing
`runtime: "claude-code"` or `runtime: "codex"`.

When creating a spec, choose planner and worker model selections independently.
The server validates each selection against the selected runtime descriptor and
stores only the explicit split selections on each Epic.

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

### Oakridge delegated sessions

oakridge-core can also create kbbl sessions as workflow execution substrates. Those
sessions use the same runtime adapters and operator approval UI as directly launched
sessions, but oakridge-core supplies `artifact_id = <stage_instance_id>` so the session
can be correlated with a workflow stage. For the full v2 operator runbook — including
the worktree contract, effort setting, tool approval policy, and migration map — see
[`../docs/oakridge-v2-runbook.md`](../docs/oakridge-v2-runbook.md).

This does not replace direct kbbl usage. The two supported launch paths are:

- Direct session: operator uses the PWA or calls `POST /sessions`.
- Delegated workflow session: oakridge-core calls `POST /sessions`, sends the workflow
  prompt with `POST /:sid/input`, and later tears the session down with
  `DELETE /sessions/:sid` when the workflow reaches its terminal gate.

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
- `POST /sessions` — create a session; body:
  `{ workdir?, resume_from?, name?, artifact_id?, model?, runtime? }`.
  `runtime` accepts `"claude-code"` or `"codex"`; omitted uses the configured default.
  With `resume_from`, forks an ended session. The response is a session snapshot whose
  session id field is `sid`.
- `DELETE /sessions/:sid` — kill a live session (`?purge=true` also deletes the transcript)
- `GET /artifacts/:artifactId/sessions` — list sessions tagged with a given workspace-layer artifact id

### Per-session

- `GET /:sid/stream` — SSE event stream for one session
- `GET /:sid/events` — replay JSONL history (falls through to disk for archived sessions)
- `POST /:sid/input` — send operator text to the session
- `POST /:sid/approval` — Approve / Deny / Always-{tool} reply for a parked PreToolUse
- `POST /:sid/yolo` — toggle the session's auto-approve mode
- `POST /:sid/compact` — operator-initiated compaction (the soft-threshold banner action)
- `GET /:sid/handoff` — markdown body of the session's compaction handoff (404 if never compacted)

### Inbox + config

- `GET /inbox` — SSE delta stream for the session list (snapshot + create/end/status/pending/activity)
- `POST /inbox/workspace-events` — local trusted callers push project / coordination events for SSE re-broadcast
- `GET /config` — server config snapshot for the PWA (`defaultWorkdir`, `softThresholdTokens`)
- `PATCH /config` — mutate `softThresholdTokens` at runtime (persisted back to `config.json`)
- `GET /directories?path=<absolute-path>` — list child directories for the new-session directory picker

### Runtime-private

- `POST /hook/approval` — `127.0.0.1`-only loopback endpoint mounted by the Claude Code adapter's gate script

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
│       ├── index.ts               # createClaudeCodeRuntime — implements AppRuntime
│       ├── spawn.ts               # CLI flags + settings.json generator
│       ├── hook-route.ts          # /hook/approval handler
│       ├── event-classifier.ts    # parses CC stdout for ccSid + result usage
│       └── scripts/gate.sh        # PreToolUse hook script invoked by CC
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
- **Hook endpoint:** `/hook/approval` is filtered to `127.0.0.1` at the route handler — only the in-process gate script can park approval requests, not a tailnet peer.
- **Path-traversal guard:** `:sid` route params are validated against a strict v4 UUID regex before any filesystem access.
- **Markdown:** assistant text is rendered with `react-markdown` + `rehype-sanitize`; no `dangerouslySetInnerHTML`, so prompt-injected HTML from web-fetched content can't execute.
- **Agent user settings (Claude Code adapter):** the server spawns CC with `--setting-sources user` so your user-level skills and slash commands are available inside the spawned subprocess. Tradeoff: user-level allowlists and permission settings in `~/.claude/settings.json` can bypass kbbl's approval gate — if you've globally approved a tool there, the PreToolUse hook won't fire for it. The operator-controlled escape hatches below (YOLO, "Always {tool}") are the intended path for short-circuiting the gate; don't rely on the gate to stop things you've already auto-approved at the user level.
- **YOLO mode and per-tool always-allow** are operator-controlled escape hatches, scoped to a single session. YOLO mode (top-bar toggle) auto-approves every PreToolUse for the rest of the session — useful for setting an agent loose on a long task without tapping each prompt. The "Always {tool}" button on a permission card adds that tool name to a session-scoped allowlist; matching future calls auto-approve. Both reset on server restart, are emitted as visible events, and turn the gate into "see what happened" rather than "decide each call." Use them deliberately.

## Known issue: permission_required stream events

Agents running under `--print --output-format stream-json` emit permission prompts as events in the JSON stream rather than as interactive terminal prompts. The PWA currently does not render these events as approval cards (only PreToolUse hook calls are rendered). If your runtime's permission system rejects something pre-hook, the rejection drops silently. Workaround: configure the runtime so the gate is the only approval surface (for Claude Code, ensure user-level allowlist covers the tool so the permission system passes through to the hook). Surfacing permission_required events in the PWA is on the roadmap.
