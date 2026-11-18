// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorAnalysisLinkEntry } from "../domain/analysis-link-declaration";
import type { OperatorPrIntegration } from "../domain/pr-integration";
import type { OperatorRunConfig } from "../domain/run-config";

export interface OperatorIngressRequest { readonly request_id: string }

export interface OperatorLaunchRequest extends OperatorIngressRequest {
  readonly pr_integration?: OperatorPrIntegration;
  readonly definition_id: string; readonly input: unknown; readonly project_id?: string | null;
  /** Session settings keyed by stage, then by agent worker, and the run's automatic-grading choice. */
  readonly config?: Pick<OperatorRunConfig, "sessions" | "grading_enabled"> | null;
}

export interface OperatorDecideRequest extends OperatorIngressRequest {
  readonly decision: string; readonly target: string; readonly payload: unknown;
  /** Assessment displayed by the operator, separate from a redirected core effect target. */
  readonly expected_assessment_revision_id?: string;
  /** Optional explicit links, declared against the tasks revision this decision approves. Nothing requires them. */
  readonly analysis_links?: readonly OperatorAnalysisLinkEntry[];
}

export interface OperatorPublishRequest extends OperatorIngressRequest { readonly body: unknown; readonly predecessor: string | null; readonly subject: string | null }

export type OperatorIngressResponse = OperatorIngressCommitted;

export interface OperatorIngressCommitted { readonly kind: "committed"; readonly run_id: string; readonly event_id: string; readonly analysis_links?: OperatorDeclaredLinks }

export type OperatorDeclaredLinks = { readonly kind: "committed"; readonly event_id: string } | { readonly kind: "refused"; readonly reason: string };
