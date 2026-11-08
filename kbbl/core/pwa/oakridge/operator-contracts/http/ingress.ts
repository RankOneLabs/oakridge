// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorRunConfig } from "../domain/run-config";
import type { OperatorDefinitionId } from "../runtime/definition-store";

export interface OperatorIngressRequest { readonly request_id: string }

export interface OperatorLaunchRequest extends OperatorIngressRequest {
  readonly definition_id: OperatorDefinitionId; readonly input: unknown; readonly project_id?: string | null;
  /** Session settings keyed by stage, then by agent worker. */
  readonly config?: OperatorRunConfig | null;
}

export interface OperatorDecideRequest extends OperatorIngressRequest { readonly decision: string; readonly target: string; readonly payload: unknown }

export interface OperatorPublishRequest extends OperatorIngressRequest { readonly body: unknown; readonly predecessor: string | null; readonly subject: string | null }

export type OperatorIngressResponse = OperatorIngressCommitted;

export interface OperatorIngressCommitted { readonly kind: "committed"; readonly run_id: string; readonly event_id: string }
