// Built-in production agent profiles (§20, cohort 2). These are the two
// profiles kbbl ships with; config.acp.agents entries override them wholesale
// by id. Only launch configuration lives here — no protocol or event
// knowledge (§8.1).

import { join } from "node:path";

import type { AgentProfile, AgentProfileId } from "./agent-profile";

/**
 * Resolve the installed bin for an ACP agent package. Both agents are
 * npm-installed dependencies whose executables land in kbbl's own
 * node_modules/.bin, so the default profile can point at a stable path
 * without requiring the operator to configure anything.
 */
function installedBin(kbblRoot: string, binName: string): string {
  return join(kbblRoot, "node_modules", ".bin", binName);
}

/**
 * The two built-in profiles. `claude-code` excludes ANTHROPIC_API_KEY by
 * default (§20.1): the selected agent runs the Agent SDK on subscription
 * OAuth, and a stray key in kbbl's environment must never silently flip a
 * session to per-token API billing. An operator who genuinely wants API
 * billing overrides the profile in config.acp.agents.
 *
 * Neither inherits an `OAKRIDGE_*` variable. Those carry the operator's
 * control tokens and the backend's keys; an agent holding one could act as
 * the operator (validation spec §3.2 item 6).
 *
 * `claude-code` starts sessions in Auto mode: kbbl hands the agent nothing
 * but a cwd, so in the SDK's "default" mode every edit and non-read-only
 * command in a run worktree waits on an operator click. Auto keeps the
 * provider's own classifier (and its bypass-immune asks) in the loop; the
 * adapter itself drops to "acceptEdits" when the model lacks Auto support.
 */
const OAKRIDGE_VARIABLES = "OAKRIDGE_*";

/**
 * The vendor CLI an ACP agent should drive, or null when none is installed.
 *
 * Both ACP packages prefer an env var naming a `claude`/`codex` binary
 * (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`) and otherwise run one bundled in
 * their own pinned dependency. That bundled binary carries the model catalog,
 * so the ACP pin — not the operator's account — decides what a session can
 * select, and it decides it silently. Both pins were behind:
 *
 *   - claude-agent-acp 0.76.0 bundles claude-agent-sdk 0.3.257, which
 *     resolves `opus`/`sonnet`/`haiku` to Opus 5, Sonnet 5 and Haiku 4.5 and
 *     answers the explicit `claude-*-5-5` ids with `unrecognized_model`. The
 *     installed CLI resolves the same three aliases to the 5.5 generation.
 *   - codex-acp 1.13.0 bundles @openai/codex 0.155.1, whose catalog has no
 *     entry for `gpt-6.1-sol`. codex-acp fetches the model *list* from its
 *     app server, so the id is advertised and the picker offers it, but
 *     capability lookup is local: the session comes up with no
 *     `reasoning_effort` option at all, and an explicit switch to that model
 *     fails with `-32602 Invalid params`. The installed CLI advertises effort
 *     on every model and one more model besides (`gpt-6.1-terra`).
 *
 * An explicit env value already in kbbl's environment wins — pinning a
 * specific binary is a deliberate act. Finding nothing on PATH leaves the
 * variable unset and the agent falls back to its bundled binary, whose
 * vocabulary RUNTIME_MODELS no longer describes: Claude's Fable entry and
 * Codex's whole effort picker stop resolving there. A machine running these
 * profiles is expected to have the vendor CLIs installed.
 */
function installedAgentCli(envVariable: string, command: string): string | null {
  const explicit = process.env[envVariable];
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return Bun.which(command);
}

export function builtinAgentProfiles(
  kbblRoot: string,
): Map<AgentProfileId, AgentProfile> {
  const profiles = new Map<AgentProfileId, AgentProfile>();
  const claudeCli = installedAgentCli("CLAUDE_CODE_EXECUTABLE", "claude");
  const codexCli = installedAgentCli("CODEX_PATH", "codex");
  profiles.set("claude-code", {
    id: "claude-code",
    label: "Claude Code (ACP)",
    command: installedBin(kbblRoot, "claude-agent-acp"),
    args: [],
    env_policy: {
      inherit: true,
      exclude: ["ANTHROPIC_API_KEY", OAKRIDGE_VARIABLES],
      set: claudeCli === null ? undefined : { CLAUDE_CODE_EXECUTABLE: claudeCli },
    },
    enabled: true,
    requireLoadSession: true,
    sessionMode: "auto",
  });
  profiles.set("codex", {
    id: "codex",
    label: "Codex (ACP)",
    command: installedBin(kbblRoot, "codex-acp"),
    args: [],
    env_policy: {
      inherit: true,
      exclude: [OAKRIDGE_VARIABLES],
      set: codexCli === null ? undefined : { CODEX_PATH: codexCli },
    },
    enabled: true,
    requireLoadSession: true,
    sessionMode: null,
  });
  return profiles;
}
