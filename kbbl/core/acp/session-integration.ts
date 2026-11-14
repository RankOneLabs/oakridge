import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as schema from "@agentclientprotocol/sdk";
import type { AgentProfile } from "./agent-profile";
import { selectMcpServers } from "./client";
import { materializeSessionSkill } from "./skill-materialize";
import { acpError, err, ok, type AcpError, type AcpSessionRow, type PrIntegration, type Result, type SessionPrIntegration } from "./types";

export interface SessionIntegrationConfig {
  readonly default_integration: PrIntegration;
  readonly gated_review_url: string | null;
  readonly skill_store_root: string;
  readonly session_skills_root: string;
}
export interface SessionIntegrationLaunch {
  readonly mcpServers: schema.McpServer[];
  readonly skillDirectory: string | null;
}
interface SkillIndex { readonly "gated-review": string; readonly "github-cli": string }
export function selectDirectIntegration(config?: SessionIntegrationConfig): Result<SessionPrIntegration, AcpError> {
  const integration = config?.default_integration ?? "none";
  if (integration === "none") return ok({ pr_integration: integration, pr_skill_digest: null });
  try {
    const index: SkillIndex = JSON.parse(readFileSync(join(config!.skill_store_root, "../skills.json"), "utf8"));
    const digest = index[integration];
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid skill index");
    return ok({ pr_integration: integration, pr_skill_digest: digest });
  } catch (cause) { return err(acpError("skill_unavailable", "selectDirectIntegration", String(cause))); }
}
export function prepareSessionIntegration(row: AcpSessionRow, profile: AgentProfile, config?: SessionIntegrationConfig): Result<SessionIntegrationLaunch, AcpError> {
  const servers = selectMcpServers(row.pr_integration, config?.gated_review_url ?? null);
  if (!servers.ok) return servers;
  if (row.pr_integration === "none" || row.pr_skill_digest === null) return ok({ mcpServers: servers.value, skillDirectory: null });
  if (profile.skillDiscovery?.kind !== "additionalDirectories") return err(acpError("skill_unavailable", "prepareSessionIntegration", `${profile.id} has no verified skill discovery path`));
  if (!config) return err(acpError("skill_unavailable", "prepareSessionIntegration", `skill ${row.pr_skill_digest}: no skill store configured`));
  const skill = materializeSessionSkill({ digest: row.pr_skill_digest, skillStoreRoot: config.skill_store_root, sessionSkillsRoot: config.session_skills_root, sid: row.sid });
  return skill.ok ? ok({ mcpServers: servers.value, skillDirectory: skill.value.directory }) : skill;
}
