// Static process-launch configuration for ACP agents (§8.1, §20). A
// profile describes HOW to start an agent binary; it carries no protocol
// or provider event knowledge.

import type { KbblConfig } from "../config";
import { acpError, err, ok, type AcpError, type Result } from "./types";

export type AgentProfileId = "claude-code" | "codex" | (string & {});

/** Per-profile environment rules (§20.1). */
export interface AgentProfileEnvPolicy {
  readonly inherit: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly set?: Readonly<Record<string, string>>;
}

export interface AgentProfile {
  readonly id: AgentProfileId;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env_policy: AgentProfileEnvPolicy;
  readonly enabled: boolean;
  /** Required for DBOS delegated-session use (§10.3, guardrail 18). */
  readonly requireLoadSession: boolean;
}

export type AcpRuntimeConfig = KbblConfig["acp"];

export function loadAgentProfiles(
  acp: AcpRuntimeConfig,
): Map<AgentProfileId, AgentProfile> {
  const profiles = new Map<AgentProfileId, AgentProfile>();
  for (const [id, agent] of Object.entries(acp.agents)) {
    profiles.set(id, {
      id,
      label: agent.label ?? id,
      command: agent.command,
      args: agent.args,
      env_policy: {
        inherit: agent.env_policy.inherit,
        include: agent.env_policy.include ?? undefined,
        exclude: agent.env_policy.exclude,
        set: agent.env_policy.set,
      },
      enabled: agent.enabled,
      requireLoadSession: agent.require_load_session,
    });
  }
  return profiles;
}

export function resolveProfile(
  profiles: ReadonlyMap<AgentProfileId, AgentProfile>,
  id: AgentProfileId,
): Result<AgentProfile, AcpError> {
  const profile = profiles.get(id);
  if (!profile) {
    return err(
      acpError(
        "agent_profile_unavailable",
        "resolveProfile",
        `no ACP agent profile named "${id}"`,
      ),
    );
  }
  if (!profile.enabled) {
    return err(
      acpError(
        "agent_profile_unavailable",
        "resolveProfile",
        `ACP agent profile "${id}" is disabled`,
      ),
    );
  }
  return ok(profile);
}

/**
 * Pure transform from the policy plus a base environment to the child's
 * environment. `exclude` wins over `include`; `set` wins over both. The
 * hardening reason this exists: a stray ANTHROPIC_API_KEY in kbbl's own
 * environment must never silently flip an agent to per-token billing.
 */
export function buildAgentEnv(
  policy: AgentProfileEnvPolicy,
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (policy.inherit) {
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined) continue;
      if (policy.include && !policy.include.includes(key)) continue;
      env[key] = value;
    }
  }
  for (const key of policy.exclude ?? []) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(policy.set ?? {})) {
    env[key] = value;
  }
  return env;
}
