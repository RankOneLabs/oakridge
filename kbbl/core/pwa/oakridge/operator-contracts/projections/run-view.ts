// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorEvent, OperatorUnitStatus, OperatorWriter } from "../core-client/core-types";
import type { OperatorRunStall } from "./attention";
import type { OperatorArtifactView, OperatorAttemptView, OperatorDecisionDefinition } from "./unit-view";
import type { OperatorDefinitionId } from "../runtime/definition-store";

export interface OperatorRunPage { readonly items: readonly OperatorRunView[]; readonly next_cursor: string | null }

export interface OperatorRunView extends OperatorRunSummary { readonly units: readonly OperatorRunUnitSummary[] }

export interface OperatorRunSummary {
  readonly run_id: string; readonly definition_id: OperatorDefinitionId;
  readonly created_at: string; readonly updated_at: string; readonly archived_at: string | null;
  readonly title: string | null; readonly repository_keys: readonly string[];
  /** The root unit's status. */
  readonly status: OperatorUnitStatus;
}

export interface OperatorRunUnitSummary {
  readonly unit_id: string;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly status: OperatorUnitStatus;
  readonly is_terminal: boolean;
  /** Keys of the decisions that ask for the operator now (not the run's cancel). */
  readonly asks: readonly string[];
}

export interface OperatorRunInspectView {
  readonly run_id: string;
  readonly status: OperatorUnitStatus;
  readonly units: readonly { readonly id: string; readonly unit_key: string; readonly label: string; readonly stage: string | null; readonly status: OperatorUnitStatus }[];
  readonly attention: readonly OperatorInspectAttention[];
  readonly artifacts: readonly OperatorArtifactView[];
  readonly attempts: readonly OperatorAttemptView[];
  /** Newest first. */
  readonly events: readonly OperatorInspectEvent[];
}

export type OperatorInspectAttention =
  /** The run could not advance past `event` (D-V4); the decisions are the run's cancel. */
  | { readonly kind: "stalled_run"; readonly unit_id: string; readonly stall: OperatorRunStall["kind"]; readonly reason: string; readonly event: OperatorEvent;
    readonly decisions: readonly OperatorDecisionDefinition[] }
  | { readonly kind: "stalled_worker"; readonly unit_id: string; readonly worker: string; readonly action_id: string; readonly detail: string;
    readonly decisions: readonly OperatorDecisionDefinition[] }
  | { readonly kind: "awaiting_review"; readonly unit_id: string; readonly review: string; readonly target: string;
    readonly decisions: readonly OperatorDecisionDefinition[] };

export interface OperatorInspectEvent { readonly id: string; readonly unit_id: string | null; readonly kind: string; readonly writer: OperatorWriter; readonly created_at: string }
