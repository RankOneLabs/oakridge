# kbbl

Browser operator surface for CLI coding agents: direct sessions, live transcripts,
permission requests, and the Oakridge v2 workflow UI. A Bun + Hono server hosts
the React PWA and manages agents through ACP (Agent Client Protocol).

## Ownership and retired functionality

Workflow orchestration runs in [oakridge-dbos](../oakridge-dbos/README.md);
definitions and prompts live in [workflow-config](../workflow-config/README.md).
The kbbl v1 Projects/spec/plan/brief UI, dispatcher, review API, and prompts are
retired. V2 launch presets use the DBOS project registry through
`/oakridge/api/projects`. The separate legacy kbbl `/projects` registry
remains available, along with shared session and v2 review components.

Existing SQLite history and migrations are retained. Retirement does not delete
stored projects, artifacts, or sessions. Archived pre-ACP JSONL sessions remain
available for read-only viewing; they are not the current execution backend.

## Quick start

From the repository root, start the complete workflow stack:

```bash
bun install
bun run oakridge
```

Open <http://127.0.0.1:8788/#oakridge>. See the
[v2 operator runbook](../docs/oakridge-v2-runbook.md) for PostgreSQL, upgrades,
recovery, and workflow lifecycle.

For standalone sessions without DBOS:

```bash
./kbbl/scripts/kbbl-start /absolute/path/to/repository
```

The workdir argument is optional and supplies the new-session form's default.
The launcher rebuilds the PWA before starting. Open <http://127.0.0.1:8788/> and
choose **+ New session**. A second launcher would compete for the same port;
create additional sessions in the PWA instead.

## Agent profiles

Both built-in ACP profiles are enabled: `claude-code` (the default) and `codex`.
Their installed agent packages are launched over ACP; kbbl no longer drives
the old stream-JSON/PreToolUse-hook or direct Codex app-server adapters.

Configure `acp.default_agent` and profile overrides under `acp.agents` in the
git-ignored `kbbl/config.json`. A missing file uses schema defaults. For example:

```json
{
  "acp": {
    "default_agent": "codex"
  }
}
```

The old `runtime.default` is a compatibility fallback when `acp.default_agent`
is absent. Other old runtime settings are ignored; `runtime.codex.enabled`
does not control the ACP profile. The checked-in `config.example.json` still
contains legacy settings, so do not use its runtime block to configure ACP.

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
agent history. Pre-ACP archives are read-only.

The old automatic compaction/handoff pipeline and YOLO/hook endpoints are not
part of the active ACP API. A retained handoff reader serves historical files;
retained compaction config fields do not enable automatic ACP compaction.

### Delegated Oakridge sessions

DBOS uses `PUT /sessions/resumable/:sessionKey` with a stable work-order key
and initial prompt. Further workflow input uses delivery-keyed requests.
Cleanup closes or fences the executor only after its work order is completed
(required outputs released) or abandoned. Artifact emission or the end of the
initial turn alone is not approval and does not trigger cleanup.

See the [runbook's recovery section](../docs/oakridge-v2-runbook.md#restart-and-recovery)
before changing application versions or attempting recovery.

## API overview

Current route contracts live in [sessions.ts](core/server/handlers/sessions.ts)
and [acp-per-sid.ts](core/server/handlers/acp-per-sid.ts).

- `GET /sessions` — list ACP sessions; `?include=archived` also includes legacy history.
- `POST /sessions` — create a session; accepts `workdir`, `name`,
  `agent_profile` (or `runtime` alias), `model`, `effort`, `artifact_id`,
  and optional `resume_from` or `worktree`. Returns a snapshot with `sid`.
- `DELETE /sessions/:sid` — close; `?fenced_by=...` fences;
  `?purge=true` requests permanent removal subject to handler guards.
- `GET /sessions/:sid/history` — projected history, expiry, and open turns.
- `GET /sessions/:sid/stream` — ACP UI events over SSE.
- `POST /sessions/:sid/input` — `{ text, client_message_id? }`.
- `POST /sessions/:sid/permissions/:requestId` — `{ option_id }`.
- `POST /sessions/:sid/cancel` — interrupt the current turn.
- `POST /sessions/:sid/config` — `{ config_id, value }`.
- `GET /artifacts/:artifactId/sessions` — sessions with a correlation tag.
- `GET /inbox` — session-list SSE; `POST /inbox/workspace-events` ingests workspace events.
- `GET /config` — defaults and available runtime descriptors.
- `GET /directories?path=<absolute-path>` — directory picker.
- `GET /:sid/handoff` — historical compaction handoff.
- `/projects` — retained legacy kbbl project registry, not the v2 registry.
- `/oakridge/api/projects` — DBOS project registry used by v2 launch presets.
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

The browser exchanges the token for an HttpOnly cookie. Non-loopback writes
require control authentication. For trusted-network development only,
`ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1` permits an unauthenticated bind.
This is not a public-internet deployment configuration.

`OAKRIDGE_CORE_BASE_URL` points to DBOS despite its retained name.
`OAKRIDGE_CORE_CONTROL_TOKEN` overrides the upstream token, otherwise
`OAKRIDGE_CONTROL_TOKEN` is used. Browser authorization is stripped before
proxying. Agent permission decisions are separate from HTTP control authentication.

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
- `core/db/` — SQLite connection, retained migrations, project registry.
- `core/worktree/` — worktree provisioning and ownership.
- `core/session/` — retained legacy archive compatibility.
- `core/pwa/hooks/useAcpSession.ts` — ACP history and stream lifecycle.
- `core/pwa/views/` and `core/pwa/components/` — session UI.
- `core/pwa/oakridge/` — v2 workflow UI.
- `core/pwa/review/` — shared DAG and collaboration components used by v2.

The [ACP compatibility report](docs/acp-compatibility.md) records the dated
agent-selection spike, not current dependency versions or an operator setup guide.
