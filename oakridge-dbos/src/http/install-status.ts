import type { ObservationHealth } from "../../../observation/src/http/health";
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
type HealthyCheckInput = Omit<Extract<InstallCheck, { kind: "ok" }>, "kind" | "required"> & { readonly required?: boolean };
type FailedCheckInput = Omit<Extract<InstallCheck, { kind: "failed" }>, "kind" | "required"> & { readonly required?: boolean };
type AbsentCheckInput = Omit<Extract<InstallCheck, { kind: "unavailable_optional" }>, "kind" | "required">;
const healthy = (input: HealthyCheckInput): InstallCheck => ({ ...input, kind: "ok", required: input.required ?? false });
const failed = (input: FailedCheckInput): InstallCheck => ({ ...input, kind: "failed", required: input.required ?? false });
const absent = (input: AbsentCheckInput): InstallCheck => ({ ...input, kind: "unavailable_optional", required: false });
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
    return { check: healthy({ id: "kbbl", label: "kbbl", detail: "kbbl profile readiness endpoint is reachable", required: true }),
      agent_profiles: profiles.value.map((profile) => ({ ...profile, readiness: { ...profile.readiness, id: `agent:${profile.profile_id}`, label: profile.label, required: false } })) };
  } catch { return { check: failed({ id: "kbbl", label: "kbbl", detail: "kbbl is unreachable or returned invalid profile readiness", fix: "Start kbbl with ./scripts/oakridge-start and check KBBL_BASE_URL", required: true }), agent_profiles: [] }; }
}
async function readIntegrationHealth(deps: InstallStatusDependencies): Promise<PrIntegrationHealth> {
  try { return await deps.probe_integration(); }
  catch { return { kind: "unreachable", detail: "Selected PR integration is unreachable" }; }
}
interface HealthFields { readonly [key: string]: unknown }
const isHealthFields = (raw: unknown): raw is HealthFields => typeof raw === "object" && raw !== null && !Array.isArray(raw);
function isObservationHealth(raw: unknown): raw is ObservationHealth {
  if (!isHealthFields(raw) || raw.service !== "observation" || raw.status !== "ok" || raw.database !== "available" || !isHealthFields(raw.graders)) return false;
  return raw.graders.state === "none_configured" || raw.graders.state === "configured" && Array.isArray(raw.graders.graders)
    && raw.graders.graders.every((grader: unknown) => isHealthFields(grader) && typeof grader.runner === "string" && typeof grader.evaluator_definition_id === "string");
}
async function readObservationAvailability(deps: InstallStatusDependencies): Promise<InstallCheck> {
  let availability = absent({ id: "observation", label: "Observation/grading", detail: "Observation is not configured", fix: "Start ./scripts/oakridge-start --observation" });
  if (deps.observation_url) {
    try {
      const response = await (deps.fetch ?? globalThis.fetch)(new URL("/health", deps.observation_url), { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        await response.body?.cancel();
        return failed({ id: "observation", label: "Observation/grading", detail: "Observation health check failed", fix: "Check the observation service and restart with --observation" });
      }
      const health: unknown = await response.json();
      if (!isObservationHealth(health)) return failed({ id: "observation", label: "Observation/grading", detail: "Observation returned an invalid health response", fix: "Check the observation service version and configuration" });
      availability = health.graders.state === "none_configured"
        ? absent({ id: "observation", label: "Observation/grading", detail: "Observation is reachable; grading is unavailable because no graders are configured", fix: "Configure graders in the PWA Grading configuration view" })
        : healthy({ id: "observation", label: "Observation/grading", detail: "Observation is reachable and graders are configured" });
    } catch { availability = failed({ id: "observation", label: "Observation/grading", detail: "Configured observation service is unreachable", fix: "Check OAKRIDGE_OBSERVATION_URL and restart with --observation" }); }
  }
  return availability;
}
/** IO boundary: probe failures become checks, never transport errors or secret-bearing exception text. */
export async function readInstallStatus(deps: InstallStatusDependencies): Promise<InstallStatus> {
  const checks: InstallCheck[] = [deps.core_ready ? healthy({ id: "dbos", label: "DBOS and evaluator", detail: "DBOS is serving and the evaluator is ready", required: true })
    : failed({ id: "dbos", label: "DBOS and evaluator", detail: "Evaluator is unavailable", fix: "Rebuild the evaluator and restart ./scripts/oakridge-start", required: true })];
  const selectedAccess = selectAccessMode(deps.access);
  if (selectedAccess.kind === "failed") throw new Error(selectedAccess.detail);
  const access_mode = selectedAccess;
  const [profiles, integrationHealth, availability] = await Promise.all([
    readAgentProfiles(deps.kbbl), readIntegrationHealth(deps), readObservationAvailability(deps),
  ]);
  const agent_profiles = profiles.agent_profiles;
  checks.push(profiles.check);
  const integrationFix = deps.integration === "github-cli" ? "Install gh and run gh auth login" : "Configure .mcp.json and start gated-review, or select another PR integration";
  const health = deps.integration === "none" ? absent({ id: "pr_integration", label: "PR integration", detail: "No PR integration selected", fix: "Set OAKRIDGE_PR_INTEGRATION to gated-review or github-cli" })
    : integrationHealth.kind === "healthy" ? healthy({ id: "pr_integration", label: "PR integration", detail: `${deps.integration} is available` })
    : failed({ id: "pr_integration", label: "PR integration", detail: `${deps.integration} is ${integrationHealth.kind}`, fix: integrationFix });
  let launch_blocks: LaunchBlock[] = [];
  try {
    launch_blocks = (deps.definitions ?? readDefinitions)().flatMap((definition) => {
      // Use safe probe details: remote failures can contain URLs with credentials.
      const safeHealth: PrIntegrationHealth = integrationHealth.kind === "healthy" ? integrationHealth : { kind: integrationHealth.kind, detail: `${deps.integration} integration is ${integrationHealth.kind}` };
      const result = preflightLaunch({ definition, integration: deps.integration, health: safeHealth });
      return result.ok ? [] : [{ definition_id: definition.definition_id, definition_name: definition.source.workflow, error: result.error }];
    });
    checks.push(healthy({ id: "definitions", label: "Pinned definitions", detail: "Pinned definitions were checked", required: true }));
  } catch { checks.push(failed({ id: "definitions", label: "Pinned definitions", detail: "Pinned definitions could not be loaded", fix: "Regenerate workflow-config and restart Oakridge", required: true })); }
  return assembleInstallStatus({ access_mode, checks, agent_profiles, pr_integration: { selected: deps.integration, health }, observation: { availability }, launch_blocks });
}
export function installStatusRoute(app: Hono, read?: () => Promise<InstallStatus>): void {
  app.get("/api/install-status", async (context) => read ? context.json(await read()) : context.json({ kind: "status_unconfigured", detail: "Installation status reader is not configured" }, 503));
}
