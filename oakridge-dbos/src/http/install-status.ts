import type { Hono } from "hono";
import type { KbblClient } from "../adapters/kbbl";
import type { PrIntegration } from "../domain/pr-integration";
import { assembleInstallStatus, selectAccessMode, type AccessModeInput, type AgentProfileStatus, type InstallCheck, type InstallStatus, type LaunchBlock } from "../projections/install-status-view";
import { readLaunchableCatalog, resolveDefinition, type ResolvedDefinition } from "../runtime/definition-store";
import { preflightLaunch, type PrIntegrationHealth } from "../runtime/pr-launch-preflight";

type StatusFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface InstallStatusDependencies {
  readonly access: AccessModeInput;
  readonly integration: PrIntegration;
  readonly probe_integration: () => Promise<PrIntegrationHealth>;
  readonly kbbl: Pick<KbblClient, "profileReadiness"> | null;
  readonly observation_url: string | null;
  readonly core_ready: boolean;
  readonly definitions?: () => readonly ResolvedDefinition[];
  readonly fetch?: StatusFetch;
}
const healthy = (id: string, label: string, detail: string, required = false): InstallCheck => ({ kind: "ok", id, label, detail, required });
const failed = (id: string, label: string, detail: string, fix: string, required = false): InstallCheck => ({ kind: "failed", id, label, detail, fix, required });
const absent = (id: string, label: string, detail: string, fix: string): InstallCheck => ({ kind: "unavailable_optional", id, label, detail, fix, required: false });
function readDefinitions(): readonly ResolvedDefinition[] {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error("Pinned definition catalog could not be read");
  return [...new Set(Object.values(catalog.value))].map((id) => {
    const definition = resolveDefinition(id);
    if (!definition.ok) throw new Error("Pinned definition could not be read");
    return definition.value;
  });
}
interface AgentProfileSources { readonly check: InstallCheck; readonly agent_profiles: AgentProfileStatus[] }
async function readAgentProfiles(kbbl: InstallStatusDependencies["kbbl"]): Promise<AgentProfileSources> {
  try {
    const profiles = await kbbl?.profileReadiness();
    if (!profiles || profiles.kind !== "acknowledged") throw new Error("kbbl unavailable");
    return { check: healthy("kbbl", "kbbl", "kbbl profile readiness endpoint is reachable", true),
      agent_profiles: profiles.value.map((profile) => ({ ...profile, readiness: { ...profile.readiness, id: `agent:${profile.profile_id}`, label: profile.label, required: false } })) };
  } catch { return { check: failed("kbbl", "kbbl", "kbbl is unreachable or returned invalid profile readiness", "Start kbbl with ./scripts/oakridge-start and check KBBL_BASE_URL", true), agent_profiles: [] }; }
}
async function readIntegrationHealth(deps: InstallStatusDependencies): Promise<PrIntegrationHealth> {
  try { return await deps.probe_integration(); }
  catch { return { kind: "unreachable", detail: "Selected PR integration is unreachable" }; }
}
async function readObservationAvailability(deps: InstallStatusDependencies): Promise<InstallCheck> {
  let availability = absent("observation", "Observation/grading", "Observation is not configured", "Start ./scripts/oakridge-start --observation");
  if (deps.observation_url) {
    try {
      const response = await (deps.fetch ?? globalThis.fetch)(new URL("/health", deps.observation_url), { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      availability = response.ok ? healthy("observation", "Observation/grading", "Observation service is reachable")
        : failed("observation", "Observation/grading", "Observation health check failed", "Check the observation service and restart with --observation");
    } catch { availability = failed("observation", "Observation/grading", "Configured observation service is unreachable", "Check OAKRIDGE_OBSERVATION_URL and restart with --observation"); }
  }
  return availability;
}
/** IO boundary: probe failures become checks, never transport errors or secret-bearing exception text. */
export async function readInstallStatus(deps: InstallStatusDependencies): Promise<InstallStatus> {
  const checks: InstallCheck[] = [deps.core_ready ? healthy("dbos", "DBOS and evaluator", "DBOS is serving and the evaluator is ready", true)
    : failed("dbos", "DBOS and evaluator", "Evaluator is unavailable", "Rebuild the evaluator and restart ./scripts/oakridge-start", true)];
  const selectedAccess = selectAccessMode(deps.access);
  if (selectedAccess.kind === "failed") throw new Error(selectedAccess.detail);
  const access_mode = selectedAccess;
  const [profiles, integrationHealth, availability] = await Promise.all([
    readAgentProfiles(deps.kbbl), readIntegrationHealth(deps), readObservationAvailability(deps),
  ]);
  const agent_profiles = profiles.agent_profiles;
  checks.push(profiles.check);
  const integrationFix = deps.integration === "github-cli" ? "Install gh and run gh auth login" : "Configure .mcp.json and start gated-review, or select another PR integration";
  const health = deps.integration === "none" ? absent("pr_integration", "PR integration", "No PR integration selected", "Set OAKRIDGE_PR_INTEGRATION to gated-review or github-cli")
    : integrationHealth.kind === "healthy" ? healthy("pr_integration", "PR integration", `${deps.integration} is available`)
    : failed("pr_integration", "PR integration", `${deps.integration} is ${integrationHealth.kind}`, integrationFix);
  let launch_blocks: LaunchBlock[] = [];
  try {
    launch_blocks = (deps.definitions ?? readDefinitions)().flatMap((definition) => {
      // Use safe probe details: remote failures can contain URLs with credentials.
      const safeHealth: PrIntegrationHealth = integrationHealth.kind === "healthy" ? integrationHealth : { kind: integrationHealth.kind, detail: `${deps.integration} integration is ${integrationHealth.kind}` };
      const result = preflightLaunch({ definition, integration: deps.integration, health: safeHealth });
      return result.ok ? [] : [{ definition_id: definition.definition_id, definition_name: definition.source.workflow, error: result.error }];
    });
    checks.push(healthy("definitions", "Pinned definitions", "Pinned definitions were checked", true));
  } catch { checks.push(failed("definitions", "Pinned definitions", "Pinned definitions could not be loaded", "Regenerate workflow-config and restart Oakridge", true)); }
  return assembleInstallStatus({ access_mode, checks, agent_profiles, pr_integration: { selected: deps.integration, health }, observation: { availability }, launch_blocks });
}
export function installStatusRoute(app: Hono, read?: () => Promise<InstallStatus>): void {
  app.get("/api/install-status", async (context) => read ? context.json(await read()) : context.json({ kind: "status_unconfigured", detail: "Installation status reader is not configured" }, 503));
}
