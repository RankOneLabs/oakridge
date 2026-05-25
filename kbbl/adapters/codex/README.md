# Codex Adapter

The Codex adapter connects kbbl to OpenAI's [Codex CLI](https://github.com/openai/codex) via its `app-server` interface. It implements the full `AgentRuntime` contract so sessions, approvals, and resumption all work through the standard kbbl operator surface.

## Architecture

```
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

Add to `kbbl/config.json`:

```json
{
  "runtime": {
    "codex": {
      "enabled": true,
      "bin": "codex",
      "listen": ""
    }
  }
}
```

- `enabled`: opt-in flag — Codex is disabled by default so existing installs see no change.
- `bin`: path to the `codex` binary. Defaults to `"codex"` (resolved via `$PATH`).
- `listen`: connection URL. Supported forms:
  - `""` (empty) — defaults to `unix://<dataDir>/codex-app-server.sock`
  - `stdio://` — spawns codex and communicates over stdin/stdout
  - `unix:///path/to/socket` — unix domain socket
  - `ws://host:port` — WebSocket

## Conformance notes

The Codex app-server protocol deviates from strict JSON-RPC 2.0 in several ways that the adapter handles explicitly:

1. **No `jsonrpc:"2.0"` on inbound messages** — the parser does not require this field.
2. **Only v2 approval methods** — `item/fileChange/requestApproval` and `item/commandExecution/requestApproval`. Legacy methods are ignored (cancel response sent).
3. **`thread/fork` does not emit `thread/started` for the child** — the child thread id is read directly from the fork response.
4. **`thread/unsubscribe` confirmed** — used for session termination; returns `{status:"unsubscribed"}`.

These findings are documented in `comms/codex-probe-findings.md`.

## Limitations (v0)

- `supportsCompaction: false` — Codex has no `/compact` equivalent; the server returns HTTP 409 for compaction requests on Codex sessions.
- Token usage data is extracted from `thread/tokenUsage/updated` notifications but does not map 1:1 to CC's `result.usage` shape. The `observeTurnEnd` bridge is wired but the token counts use Codex's `last` bucket (per-turn delta).
