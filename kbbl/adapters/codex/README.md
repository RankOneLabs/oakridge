# Codex Adapter

The Codex adapter connects kbbl to OpenAI's [Codex CLI](https://github.com/openai/codex) via its `app-server` interface. It implements the full `AgentRuntime` contract so sessions, approvals, and resumption all work through the standard kbbl operator surface.

## Architecture

```text
kbbl server
  └─ createCodexRuntime()
        └─ startCodexAppServer()
              └─ CodexAppServerClient
                    └─ CodexTransport (stdio / unix-socket / ws)
                          └─ codex app-server --listen <url>
```

### Protocol layer (`protocol/`)

- **`generated/types.ts`** — TypeScript types derived from JSONL fixtures and protocol documentation. Do not edit by hand.
- **`transport.ts`** — Three transport implementations: stdio (spawns process), unix-socket (`Bun.connect`), WebSocket.
- **`client.ts`** — `CodexAppServerClient`: JSONRPC-like multiplexer over a transport. Handles request/response correlation, notification routing by thread id, and server-initiated approval requests.

### Normalization layer

- **`events.ts`** — Maps Codex notifications to kbbl envelope events.
- **`approvals.ts`** — Maps Codex approval server-requests to kbbl `NormalizedApproval` objects.
- **`models.ts`** — Normalizes the `model/list` result.

### Lifecycle layer

- **`app-server.ts`** — `startCodexAppServer()`: spawns (or connects to) the codex app-server, sends `initialize`, fetches model list.
- **`resume.ts`** — `resolveCodexResumeRef()`: reads the archived JSONL and extracts the Codex thread id for `thread/fork` on resume.
- **`index.ts`** — `createCodexRuntime()`: assembles all pieces into an `AgentRuntime`.

## Regen command

```sh
codex app-server generate-ts \
  --out kbbl/adapters/codex/protocol/generated \
  --experimental
```

Run this when upgrading codex-cli to regenerate `protocol/generated/types.ts`.

## Config

Enable Codex by setting `runtime.codex.enabled = true` in `kbbl/config.json`:

```json
{
  "runtime": {
    "default": "claude-code",
    "codex": {
      "enabled": true,
      "bin": "codex"
    }
  }
}
```

- `enabled`: opt-in flag — Codex is disabled by default so existing installs see no change.
- `bin`: path to the `codex` binary. Defaults to `"codex"` (resolved via `$PATH`).
- `listen` (optional): connection URL. When absent, defaults to `unix://<dataDir>/codex-app-server.sock`. Supported forms:
  - `stdio://` — spawns codex and communicates over stdin/stdout
  - `unix:///path/to/socket` — unix domain socket (default when omitted)
  - `ws://host:port` or `wss://host:port` — WebSocket

## Approval mapping

The kbbl PWA shows a single approval card per tool call. Codex sends two approval request methods; the adapter maps them to kbbl `tool_name` values the operator sees:

| Codex request method | kbbl `tool_name` | Input shape |
|---|---|---|
| `item/fileChange/requestApproval` | `ApplyPatch` | `{ type: "ApplyPatch", changes: [...], reason: string \| null }` |
| `item/commandExecution/requestApproval` | `Exec` | `{ type: "Exec", command: string, cwd: string, commandActions: [...] }` |

Unknown or legacy approval methods receive a cancel response and are otherwise ignored.

## Conformance notes

The Codex app-server protocol deviates from strict JSON-RPC 2.0 in several ways that the adapter handles explicitly:

1. **No `jsonrpc:"2.0"` on inbound messages** — the parser does not require this field.
2. **Only v2 approval methods** — `item/fileChange/requestApproval` and `item/commandExecution/requestApproval`. Unknown or legacy methods receive a cancel response and are otherwise ignored.
3. **`thread/fork` does not emit `thread/started` for the child** — the child thread id is read directly from the fork response.
4. **`thread/unsubscribe` confirmed** — used for session termination; returns `{status:"unsubscribed"}`.

These findings are documented in `comms/codex-probe-findings.md`.

## Limitations (v0)

- **No compaction** — `supportsCompaction: false`. Codex has no `/compact` equivalent; the server returns HTTP 409 for compaction requests on Codex sessions. Evaluate `thread/compact/start` in a follow-up.
- **No cross-runtime resume** — A session started under `claude-code` cannot be resumed under `codex` and vice versa. Resume semantics are runtime-specific; cross-runtime handoff is not planned.
- **No `thread/archive` on Stop** — When the operator stops a Codex session, kbbl sends `thread/unsubscribe` and finalizes the session. The Codex thread is still forkable (resume still reads `runtime_session_observed` from JSONL), but the app-server does not archive it.
- **No auto-reattach after app-server crash** — If the codex app-server process crashes, live Codex sessions receive a `runtime_disconnected` event and finalize. kbbl does not attempt to reattach. Restart kbbl to reconnect.
- **No resume when worktrees are enabled** — When `sessions.worktree_per_session = true`, each session's working directory is a git worktree. Codex resume currently does not restore the worktree, so session state is recoverable at the thread level but the filesystem context may differ.
- **Token usage** — Extracted from `thread/tokenUsage/updated` notifications using Codex's `last` (per-turn delta) bucket. Does not map 1:1 to CC's `result.usage` shape; cost fields are not populated.
- **Startup readiness** — Unix-socket mode polls for the socket file via `access()`. WebSocket mode uses a fixed 500ms delay. Both can race on a very slow or loaded machine.
- **PWA runtime selector** — The new-session form always creates a CC session. `POST /sessions` does not currently accept a `runtime` field — runtime selection is a planned follow-up (`docs/codex-followups.md` §6).
