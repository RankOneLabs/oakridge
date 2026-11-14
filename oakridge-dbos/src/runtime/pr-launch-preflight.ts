import type { DefinitionId } from "./definition-store";
import type { PrIntegration, PrLaunchPreflightError } from "../domain/pr-integration";
import type { Group, WorkflowDefinitionDescriptor } from "../core-client/source-types";
import { err, ok, type Result } from "../domain/primitives";

/** Reachable authored workers, resolving templates without inventing workflow syntax. */
export function prOperationKeys(definition: WorkflowDefinitionDescriptor): string[] {
  const stageNames = (group: Group): string[] => Object.values(group.units).flatMap((unit) => [
    ...(unit.stage ? [unit.stage] : []), ...(unit.group ? stageNames(unit.group) : []),
  ]);
  return [...new Set(stageNames(definition.run).flatMap((stage) => Object.values(definition.stages[stage]?.workers ?? {}).flatMap((use) => {
    const worker = "template" in use ? definition.workers?.[use.template] : use;
    const operation = "template" in use && use.overrides?.operation != null ? use.overrides.operation
      : worker?.kind === "code" ? worker.operation : null;
    return operation ? [operation] : [];
  })))].sort();
}
export const isPrDependent = (definition: WorkflowDefinitionDescriptor): boolean =>
  prOperationKeys(definition).some((key) => key.startsWith("pull_request."));

export type PrIntegrationHealth = { readonly kind: "healthy" }
  | { readonly kind: "unconfigured" | "unreachable"; readonly detail: string };
export interface PrLaunchPreflightInput {
  readonly definition: { readonly definition_id: DefinitionId; readonly source: WorkflowDefinitionDescriptor };
  readonly integration: PrIntegration;
  readonly health: PrIntegrationHealth;
}
export function preflightLaunch({ definition, integration, health }: PrLaunchPreflightInput): Result<void, PrLaunchPreflightError> {
  if (!isPrDependent(definition.source)) return ok(undefined);
  const definition_id = definition.definition_id;
  if (integration === "none") return err({ kind: "integration_none", integration, definition_id,
    detail: `${definition_id} uses pull_request operations and the selected PR integration is none`,
    fix: "Launch with pr_integration gated-review or github-cli, or set OAKRIDGE_PR_INTEGRATION" });
  if (health.kind === "healthy") return ok(undefined);
  return err({ kind: health.kind === "unconfigured" ? "integration_unconfigured" : "integration_unreachable",
    integration, definition_id, detail: health.detail,
    fix: health.kind === "unreachable" ? "Start the gated-review service at the configured URL or choose another integration explicitly"
      : integration === "gated-review" ? "Configure the gated-review server in .mcp.json and restart" : "Install gh and run gh auth login" });
}
