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
 * The `claude` executable the Claude Code ACP agent should drive.
 *
 * `claude-agent-acp` prefers `CLAUDE_CODE_EXECUTABLE` and otherwise runs the
 * `claude` binary bundled inside its own pinned
 * `@anthropic-ai/claude-agent-sdk`. That bundled binary carries its own model
 * catalog, so the ACP pin — not the operator's account — decides which models
 * a session can select, and it decides it silently. The SDK 0.3.257 that
 * claude-agent-acp 0.76.0 depends on resolves `opus`/`sonnet`/`haiku` to Opus
 * 5, Sonnet 5 and Haiku 4.5 and answers the explicit `claude-*-5-5` ids with
 * `unrecognized_model`, while the operator's installed CLI resolves the same
 * three aliases to Opus 5.5, Sonnet 5.5 and Haiku 5.5. Left unset, every kbbl
 * session runs a model generation behind the one the account is entitled to.
 *
 * So kbbl points the agent at the installed CLI. An explicit
 * `CLAUDE_CODE_EXECUTABLE` already in kbbl's environment wins — pinning a
 * specific binary is a deliberate act. Finding no `claude` on PATH leaves the
 * variable unset and the agent falls back to its bundled binary, whose
 * vocabulary is the older one RUNTIME_MODELS no longer describes: the Fable
 * entry fails to resolve there. A machine running the claude-code profile is
 * expected to have the CLI installed.
 */
function installedClaudeCli(): string | null {
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return Bun.which("claude");
}

export function builtinAgentProfiles(
  kbblRoot: string,
): Map<AgentProfileId, AgentProfile> {
  const profiles = new Map<AgentProfileId, AgentProfile>();
  const claudeCli = installedClaudeCli();
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
    env_policy: { inherit: true, exclude: [OAKRIDGE_VARIABLES] },
    enabled: true,
    requireLoadSession: true,
    sessionMode: null,
  });
  return profiles;
}
