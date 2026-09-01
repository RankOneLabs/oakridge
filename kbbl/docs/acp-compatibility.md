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

## Claude candidate 2 — `@agentclientprotocol/claude-agent-acp` 0.70.0: WORKS, WRONG BILLING BUCKET

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
subscription OAuth, which on the Agent SDK path draws from the **separate
monthly Agent SDK credit**, not interactive-plan usage. Under the operator's
2026-08-31 ruling (interactive billing only) this **fails the gate** on
billing despite being functionally flawless.

> Operator verification pending: the spike sent two tiny prompts + one
> cancelled prompt through this agent (~2026-08-31 evening, session
> `96438c5f`). Check the Claude usage view to confirm which bucket they hit.

## Claude candidate 3 — `harukitosa/claude-code-acp`: NOT RUN

Ruled out by construction: it shells out to `claude -p`, which bills to the
same Agent SDK bucket as candidate 2 while offering a weaker protocol surface.
Per the re-ranked §6.1 it is only worth evaluating if its `-p` usage could be
replaced upstream; it cannot without forking.

## Gate status and recommendation

- **Codex candidate selected:** `@agentclientprotocol/codex-acp@1.7.0`. Cohort 2
  stage 1 can proceed.
- **Claude gate: no ready-made candidate passes.** The §6.3 contingency is the
  recommended path: a thin ACP server shim over kbbl's existing, production-
  proven claude-code adapter machinery (Channels push for input, hook/transcript
  integration, trust seeding), run as a separate process. Candidate 1 proves the
  shape is expressible in ACP (its protocol layer is fine); its PTY input layer
  is the only broken part, and kbbl's adapter already solved that problem with
  Channels.
- The alternative is an operator reversal on billing: if Agent SDK credit
  becomes acceptable, candidate 2 is production-ready today with the best
  capability matrix. That is an operator decision, not an engineering one.
- `session/load` works on both functioning agents — the §7 no-transcript-store
  ownership model holds. No unresolved question remains about `session/load`
  for the selected production profiles.
