# ACP compatibility report — cohort 0 spike

Date: 2026-08-31. Produced by `kbbl/scripts/acp-smoke.ts` against real agents on
otto (linux x64, node 22.21.1, bun). Spec: `comms/oakridge-kbbl-acp-migration-spec.md`
§6, §23 cohort 0.

Reproduce any row:

```bash
bun kbbl/scripts/acp-smoke.ts --agent "<abs path to agent bin>" --cwd <trusted scratch repo>
```

## Pinned versions

| package | version | role |
|---|---|---|
| `@agentclientprotocol/sdk` | 1.4.0 | protocol SDK (dependency) |
| `@agentclientprotocol/codex-acp` | 1.7.0 | Codex agent (devDependency, spike) |
| `@agentclientprotocol/claude-agent-acp` | 0.70.0 | Claude candidate 2 (devDependency, spike) |
| `claude-code-cli-acp` | 0.1.1 | Claude candidate 1 (devDependency, spike) |

Host CLIs at spike time: `codex-cli 0.151.0` (unused — see below), `claude 2.1.252`.

## Codex — `@agentclientprotocol/codex-acp` 1.7.0: SELECTED

All nine smoke steps pass: initialize, session/new, config discovery, streamed
prompt, second prompt (continuity), cancel (`stopReason=cancelled`), child kill,
fresh child + `session/load` with full history replay.

| capability | value |
|---|---|
| loadSession | true |
| session/resume | true |
| session/close | true |
| session/list | true |
| session/fork | false |
| promptCapabilities.image | true |
| promptCapabilities.embeddedContext | true |
| mcpCapabilities | http only |

Config options: `mode[mode]`, `collaboration_mode[collaboration_mode]`,
`model[model]`, `reasoning_effort[thought_level]`, `fast-mode[model_config]` —
the `model` / `thought_level` categories match the §12 resolver algorithm
directly.

Notes:

- It vendors its own pinned `@openai/codex@0.148.0` and runs `codex app-server`
  as an internal child — the app-server lifecycle problem moves wholly outside
  kbbl, and the system `codex` install version is irrelevant to it.
- Auth methods advertised: `api-key`, `chat-gpt`. The spike used the existing
  `~/.codex` ChatGPT login; prompts succeeded with no extra configuration.

## Claude candidate 1 — `claude-code-cli-acp` 0.1.1: FAILS (prompt delivery)

The one candidate whose billing path satisfies the gate, and the one that
cannot run a prompt.

What works: initialize (v1), `session/new`, config discovery
(`mode`/`model[model]`/`effort[thought_level]`), capability advertisement
(loadSession, close, list). **Billing evidence:** during the prompt it spawned
`/home/steve/.local/bin/claude --session-id <uuid>` — the real interactive CLI,
no `--print` — via portable-pty. That is interactive-plan billing.

What fails: `session/prompt` never produces agent output. First run returned
JSON-RPC `Internal error` (untrusted directory — the bridge does not seed
`hasTrustDialogAccepted` the way `kbbl/adapters/claude-code/spawn.ts` does).
After seeding trust, the prompt hangs to timeout with only the bridge's own
`user_message_chunk` echo; no transcript JSONL and no project dir were ever
created under `~/.claude/projects`, so the typed prompt never reached Claude's
composer. `session/load` after restart returns `Resource not found`
(consistent: no transcript was written).

Diagnosis: PTY keystroke injection bitrot against claude 2.1.252 (package
published 2026-05-14). This is precisely the input fragility kbbl abandoned
when `send()` moved to the Channels push transport (PR #277).

## Claude candidate 2 — `@agentclientprotocol/claude-agent-acp` 0.70.0: SELECTED

All nine smoke steps pass, richest capability matrix of the three:

| capability | value |
|---|---|
| loadSession | true |
| session/resume | true |
| session/close | true |
| session/list | true |
| session/fork | true |
| promptCapabilities.image | true |
| promptCapabilities.embeddedContext | true |
| mcpCapabilities | http + sse |

Config options: `mode[mode]`, `model[model]`, `effort[thought_level]`. Modes
mirror Claude Code permission modes (`default`, `acceptEdits`, `plan`,
`dontAsk`, `bypassPermissions`, `auto`).

Billing: no child `claude` process — it runs the Claude Agent SDK in-process.
`ANTHROPIC_API_KEY` was confirmed absent from the environment, so the run used
subscription OAuth, which on the Agent SDK path draws from the separate monthly
Agent SDK credit bucket. The operator's initial 2026-08-31 ruling excluded that
bucket; the operator revised the ruling the same day after seeing the spike
results — **the Agent SDK path is acceptable**, so this candidate passes the
billing criterion and, having passed all nine protocol steps, is selected.

> Operator verification still worthwhile: the spike sent two tiny prompts + one
> cancelled prompt through this agent (2026-08-31 evening, session `96438c5f`).
> Check the Claude usage view to confirm they hit a subscription bucket and not
> API billing.

## Claude candidate 3 — `harukitosa/claude-code-acp`: NOT RUN

Ruled out by construction: it shells out to `claude -p`, which bills to the
same Agent SDK bucket as candidate 2 while offering a weaker protocol surface.
Per the re-ranked §6.1 it is only worth evaluating if its `-p` usage could be
replaced upstream; it cannot without forking.

## Gate status and recommendation

- **Codex candidate selected:** `@agentclientprotocol/codex-acp@1.7.0`. Cohort 2
  stage 1 can proceed.
- **Claude candidate selected:** `@agentclientprotocol/claude-agent-acp@0.70.0`.
  The operator's initial interactive-billing-only ruling would have failed it;
  the operator revised that ruling on 2026-08-31 (Agent SDK path acceptable),
  and it passes every protocol step with the best capability matrix of the
  three. No API key required or wanted: it authenticates via the existing
  subscription OAuth login, and the profile env policy must exclude
  `ANTHROPIC_API_KEY` so a stray key can never silently flip sessions to
  per-token API billing.
- The §6.3 PTY-bridge contingency stays dormant. It becomes relevant only if
  the billing ruling reverts to interactive-only or cohort 2 stage 2's deeper
  checks (`.claude` instructions, hooks, skills, MCP, worktree cwd, orphan
  cleanup) surface a disqualifier.
- `session/load` works on both selected agents — the §7 no-transcript-store
  ownership model holds. No unresolved question remains about `session/load`
  for the selected production profiles.
