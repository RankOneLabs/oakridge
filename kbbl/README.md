# kbbl

Browser operator surface for CLI coding agents: direct sessions, live transcripts,
permission requests, and the Oakridge workflow UI. A Bun + Hono server hosts
the React PWA and manages agents through ACP (Agent Client Protocol).

## Ownership

Workflow orchestration runs in [oakridge-dbos](../oakridge-dbos/README.md);
definitions and prompts live in [workflow-config](../workflow-config/README.md).
Projects are registered there too (`/oakridge/api/projects`). kbbl's SQLite
ledger holds only ACP sessions, their turns and terminal summaries; a session a
workflow runs carries its `run_id`, `unit_id` and `worker`.

## Quick start

For the workflow backend and operator PWA together, run
`./scripts/oakridge-start` from the repository root. To start kbbl independently
for direct agent sessions, run:

```bash
./kbbl/scripts/kbbl-start /absolute/path/to/repository
```

The workdir argument is optional and supplies the new-session form's default.
The launcher rebuilds the PWA before starting. Open <http://127.0.0.1:8788/> and
choose **+ New session**. A second launcher would compete for the same port;
create additional sessions in the PWA instead.

## Agent profiles

Both built-in ACP profiles are enabled: `claude-code` (the default) and `codex`.
Their installed agent packages are launched over ACP.

Configure `acp.default_agent` and profile overrides under `acp.agents` in the
git-ignored `kbbl/config.json`. A missing file uses schema defaults. For example:

```json
{
  "acp": {
    "default_agent": "codex"
  }
}
```

`acp.default_agent` defaults to `claude-code`. The config schema is strict: an
unknown block or field fails startup. `config.example.json` shows the shape.

Profile definitions and configuration validation are in
[default-profiles.ts](core/acp/default-profiles.ts),
[agent-profile.ts](core/acp/agent-profile.ts), and [config.ts](core/config.ts).
Agent model, effort, mode, and command choices are discovered from the agent.

The built-in Claude profile excludes `ANTHROPIC_API_KEY` from its inherited
environment to avoid silently selecting API-key billing. Agent authentication
must already be available to the server's user.

## Session lifecycle

SQLite stores session identity, queued turns, and worktree ownership. Agents own
their conversation histories. The PWA reads projected ACP events via history
and SSE endpoints; kbbl can lazily reload agent history after an idle child is
reaped or the server restarts.

Finishing a turn does not close the session. Operator input queues durably behind
an active turn. Permission cards answer the exact options offered by the agent;
interrupting a turn is distinct from closing or fencing its session.

`resume_from` on direct session creation inherits the parent's worktree and
runtime selection into a new session; it is not a promise to fork conversation
history. Continuing an existing resumable session uses its stable identity and
agent history.

### Delegated Oakridge sessions

The DBOS executor starts an attempt's session with
`PUT /sessions/resumable/:sessionKey`, keyed by the attempt and carrying the
initial prompt and the workflow identity `{run_id, unit_id, worker}`. Further
input uses delivery-keyed requests. When the attempt ends, the executor closes
the session with `?closed_by=<action_id>`, or fences it with
`?fenced_by=<action_id>` when the worker runs fresh sessions. While an attempt
is running, `GET /oakridge/api/session_holds/:sid` names it, and kbbl refuses
to close the held session unless the close names that attempt or the operator
repeats it with `?force=1`.

## API overview

Current route contracts live in [sessions.ts](core/server/handlers/sessions.ts)
and [acp-per-sid.ts](core/server/handlers/acp-per-sid.ts).

- `GET /sessions` — list ACP sessions.
- `POST /sessions` — create a session; accepts `workdir`, `name`,
  `runtime` (the agent profile), `model`, `effort`, `artifact_id`,
  and optional `resume_from` or `worktree`. Returns a snapshot with `sid`.
- `DELETE /sessions/:sid` — close; `?closed_by=...` or `?fenced_by=...` names
  the attempt that closes it; `?purge=true` requests permanent removal subject
  to handler guards.
- `GET /sessions/:sid/history` — projected history, expiry, and open turns.
- `GET /sessions/:sid/stream` — ACP UI events over SSE.
- `POST /sessions/:sid/input` — `{ text, client_message_id? }`.
- `POST /sessions/:sid/permissions/:requestId` — `{ option_id }`.
- `POST /sessions/:sid/cancel` — interrupt the current turn.
- `POST /sessions/:sid/config` — `{ config_id, value }`.
- `GET /artifacts/:artifactId/sessions` — sessions with a correlation tag.
- `GET /inbox` — session-list SSE.
- `GET /live?topic=...` — combines `/inbox`, `/oakridge/api/events`, and selected
  `/sessions/:sid/stream` topics into one SSE connection per browser page.
  Each `live` event carries `{ topic, frame: { event, data, id? } }`; the original
  stream payloads and session replay epochs are preserved. Topic changes reopen
  the feed and replay current state. Closing a page releases every underlying
  subscription. Multiple pages can stream while leaving browser connections
  available for message requests.
  Oakridge event ids also become outer SSE ids for native reconnects. When
  replacing the connection after a topic change, the browser passes its latest
  `oakridge_cursor`; only the Oakridge source receives it as `Last-Event-ID`.
  Upstream retries retain that cursor, while session sources replay their own
  history without receiving another stream's id.
- `GET /config` — defaults and available runtime descriptors.
- `GET /directories?path=<absolute-path>` — directory picker.
- `/oakridge/api/*` — same-origin DBOS proxy.

Executor integration additionally uses resumable ensure, initial-turn observation,
delivery-keyed input, and explicit advance routes in `sessions.ts`. These are
workflow integration contracts, not replacements for browser session controls.

## Remote access and security

Keep DBOS on loopback and expose only kbbl on a trusted LAN or tailnet:

```bash
export OAKRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
./kbbl/scripts/kbbl-start --host=0.0.0.0
```

The PWA asks for the token once and exchanges it for an HttpOnly cookie.
With `OAKRIDGE_CONTROL_TOKEN` set, every write and every proxied Oakridge
operator route requires it, on any bind, loopback included: otherwise any
local process, an agent among them, could act as the operator through the
proxy. Without a token, a loopback bind runs open. For trusted-network
development only, `ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1` permits an
unauthenticated non-loopback bind. This is not a public-internet deployment
configuration.

`OAKRIDGE_CORE_BASE_URL` points to the oakridge-dbos backend.
`OAKRIDGE_CORE_CONTROL_TOKEN` overrides the upstream token, otherwise
`OAKRIDGE_CONTROL_TOKEN` is used. With an upstream token but no
`OAKRIDGE_CONTROL_TOKEN`, the proxy has no browser credential to check and
refuses every operator route. Browser authorization is stripped before
proxying. The oakridge-dbos executor presents kbbl's token on its session
calls (`KBBL_CONTROL_TOKEN`, or `OAKRIDGE_CONTROL_TOKEN`). Agent permission decisions are separate from HTTP control authentication.

`OAKRIDGE_FALLBACK_REFRESH_MS` sets the operator surface's fallback refresh
interval without a PWA rebuild; it is served from `/oakridge/config` and takes
precedence over the bundle's `VITE_OAKRIDGE_FALLBACK_REFRESH_MS` default.
That precedence holds only at or above the PWA's 1,000 ms minimum: the server
accepts any positive value, but a served interval below the minimum is ignored
by the PWA, which falls back to the bundle default and then to 30,000 ms.

## Development and layout

From `kbbl/`:

```bash
./scripts/kbbl-start
# Separate terminal:
bun run dev:pwa
# Tests:
bun run test:all
```

Run `bun run typecheck` from the repository root. Vite serves development UI
on port 5173; production assets are built into `core/pwa/dist/`.

- `core/acp/` — profiles, process supervision, sessions, turn ledger, ACP projections.
- `core/server/` — HTTP handlers, control auth, and DBOS proxy.
- `core/db/` — SQLite connection and the ledger's baseline migration.
- `core/worktree/` — worktree provisioning and ownership.
- `core/session/` — session holds, git worktree helpers, keyed serialization.
- `core/pwa/hooks/useAcpSession.ts` — ACP history and stream lifecycle.
- `core/pwa/views/` and `core/pwa/components/` — session UI.
- `core/pwa/oakridge/` — workflow UI.
- `core/pwa/review/` — shared DAG and collaboration components.

The [ACP compatibility report](docs/acp-compatibility.md) records the dated
agent-selection spike, not current dependency versions or an operator setup guide.
