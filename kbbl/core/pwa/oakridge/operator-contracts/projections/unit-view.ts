// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorAdjudicationRole, OperatorAttemptStatus, OperatorCause, OperatorDeclaredDecisionEffect, OperatorMode, OperatorUnitStatus, OperatorWriter } from "../core-client/core-types";
import type { OperatorAdjudication } from "../domain/adjudication";
import type { OperatorPinnedPrompt } from "../domain/effect-instruction";
import type { OperatorJsonValue } from "../domain/primitives";
import type { OperatorInputProvenanceView } from "../domain/unit-status";
import type { OperatorReviewHistoryEngineInputs } from "../effects/session-prompt";
import type { OperatorAttention } from "./attention";
import type { OperatorBlockerHistory } from "./history-view";

export interface OperatorUnitView {
  readonly blocker?: OperatorBlockerHistory | null;
  readonly input_provenance: OperatorInputProvenanceView;
  readonly unit_id: string;
  readonly run_id: string;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly collection_key: string | null;
  readonly input: OperatorBodyValue;
  readonly depends_on: readonly string[];
  readonly status: OperatorUnitStatus;
  readonly outcome: OperatorBodyValue | null;
  readonly is_terminal: boolean;
  readonly attention: OperatorAttention | null;
  readonly decisions: readonly OperatorDecisionDefinition[];
  /** Decisions already made on the unit's revisions, oldest first. */
  readonly recorded_decisions: readonly OperatorRevisionDecision[];
  readonly attempts: readonly OperatorAttemptView[];
  readonly artifacts: readonly OperatorArtifactView[];
}

export interface OperatorArtifactView {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  /** The schema name the PWA's viewer registry dispatches on. */
  readonly schema: string;
  /** An operator review of this artifact is declared. */
  readonly is_reviewable: boolean;
  /** A review of this artifact declares an adjudication decision, so the operator adjudicates its next actions. */
  readonly is_adjudicated: boolean;
  /** An agent creates it, so the operator may publish an edited revision. */
  readonly is_editable: boolean;
  readonly revision_count: number;
  readonly latest_revision: OperatorArtifactRevisionView | null;
}

export interface OperatorAttemptView {
  /** Opaque: `<action id>:<seq>`. Show the worker, mode and cause instead. */
  readonly id: string;
  readonly unit_id: string;
  readonly worker: string;
  /** The attempt's position among its worker's attempts on the unit, from 1, in the order commit opened them. */
  readonly number: number;
  readonly status: OperatorAttemptStatusKind;
  readonly failure: OperatorAttemptFailure | null;
  readonly mode: OperatorMode["kind"];
  readonly cause: OperatorCause;
  readonly kbbl_session_id: string | null;
  readonly intent: OperatorAttemptIntentView | null;
  readonly created_at: string;
  /** The worker's latest attempt; earlier ones are superseded. */
  readonly is_current: boolean;
}

export interface OperatorDecisionDefinition {
  readonly is_available?: boolean;
  readonly disabled_reason?: string | null;
  /** Unique within the unit: the decision key, `<review>:<decision>` where a stage reuses a key across reviews, `retry:<worker>`, or `cancel`. */
  readonly key: string;
  readonly label: string;
  readonly payload_schema: string;
  readonly adjudication: OperatorAdjudicationRole | null;
  readonly assessment: string | null;
  /** Labels for the payload's text fields. */
  readonly fields: readonly OperatorDecisionField[];
  readonly submit: OperatorDecisionSubmit;
}

export type OperatorBodyValue = OperatorJsonValue;

export interface OperatorRevisionDecision {
  readonly id: string;
  readonly review: string;
  readonly decision: string;
  readonly effect: OperatorDeclaredDecisionEffect;
  readonly target_revision_id: string;
  readonly payload: OperatorBodyValue;
  readonly assessment_revision_id?: string | null;
  readonly adjudication?: OperatorAdjudication | null;
  readonly actor?: OperatorWriter | null;
  readonly created_at: string;
}

export type OperatorDecisionSubmit =
  | { readonly kind: "review"; readonly review: string; readonly decision: string; readonly effect: OperatorDeclaredDecisionEffect; readonly target_revision_id: string }
  | { readonly kind: "retry"; readonly worker: string }
  | { readonly kind: "cancel" };

export interface OperatorArtifactRevisionView {
  /** Identity of the pinned artifact contract, shared with observation capture. */
  readonly artifact_schema_version: string | null;
  readonly id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  /** The attempt that published it, as AttemptView.id; null for an operator's edit. */
  readonly attempt_id: string | null;
  readonly body: OperatorBodyValue;
  readonly predecessor_id: string | null;
  /** The revision a review artifact reviews. */
  readonly subject_id: string | null;
  readonly created_at: string;
  /** The revision's position in its artifact, from 1. */
  readonly number: number;
}

export type OperatorAttemptStatusKind = OperatorAttemptStatus["kind"];

export interface OperatorAttemptFailure { readonly code: string; readonly detail: string }

export interface OperatorAttemptIntentView {
  readonly input_provenance: OperatorInputProvenanceView;
  readonly inputs: OperatorBodyValue;
  readonly engine_inputs: OperatorReviewHistoryEngineInputs;
  readonly prompt: OperatorPinnedPrompt | null;
}

export interface OperatorDecisionField { readonly key: string; readonly label: string }
