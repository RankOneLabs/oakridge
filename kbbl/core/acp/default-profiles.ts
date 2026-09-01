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
 */
export function builtinAgentProfiles(
  kbblRoot: string,
): Map<AgentProfileId, AgentProfile> {
  const profiles = new Map<AgentProfileId, AgentProfile>();
  profiles.set("claude-code", {
    id: "claude-code",
    label: "Claude Code (ACP)",
    command: installedBin(kbblRoot, "claude-agent-acp"),
    args: [],
    env_policy: { inherit: true, exclude: ["ANTHROPIC_API_KEY"] },
    enabled: true,
    requireLoadSession: true,
  });
  profiles.set("codex", {
    id: "codex",
    label: "Codex (ACP)",
    command: installedBin(kbblRoot, "codex-acp"),
    args: [],
    env_policy: { inherit: true },
    enabled: true,
    requireLoadSession: true,
  });
  return profiles;
}
