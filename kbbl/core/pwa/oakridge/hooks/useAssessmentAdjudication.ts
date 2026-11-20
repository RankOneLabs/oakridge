import { useRef, useState } from "react";
import { randomUuid } from "../../lib/random-uuid";
import type { ParkedGate } from "../artifact-types";
import { decisionAction } from "../adapters/core";
import type { CurrentAssessment } from "../lib/current-assessment";
import { addAction, initialAdjudication, selectAdjudicationDecision, selectAdjudicationGate, selectAdjudicationPayload, selectBuilderPreview, setDisposition,
  type AddedActionInput, type AdjudicationGateState, type AdjudicationState, type DispositionChoice, type ReviewDecisionDefinition } from "../lib/assessment-adjudication";
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { useResumeGate } from "./useResumeGate";

export interface AssessmentAdjudicationInput { readonly assessment: CurrentAssessment; readonly revisionId: string; readonly gate: ParkedGate | null; readonly decisions: readonly OperatorRevisionDecision[] }
export interface AssessmentAdjudication extends AdjudicationGateState {
  readonly state: AdjudicationState;
  readonly gate: ParkedGate | null;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly choose: (action_id: string, choice: DispositionChoice) => void;
  readonly add: (input: AddedActionInput) => void;
  readonly submit: (decision: ReviewDecisionDefinition) => void;
  readonly requestAssessmentChanges: (decision: OperatorDecisionDefinition, feedback: string) => void;
}

/** The pending adjudication the decision bar and the actions list share, and the mutations that record it. */
export function useAssessmentAdjudication({ assessment, revisionId, gate, decisions }: AssessmentAdjudicationInput): AssessmentAdjudication {
  const [state, setState] = useState(() => initialAdjudication(assessment));
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // A retried submit of the same decision and payload reuses its key, so the authority records it once.
  const keys = useRef(new Map<string, string>());
  const mutation = useResumeGate(gate?.id ?? "", gate?.run_id ?? null);
  const gateState = selectAdjudicationGate({ gate, revisionId, decisions, hasSubmitted });
  const isClosed = !gateState.isOpen || mutation.isPending;
  const recorded = { onSuccess: () => setHasSubmitted(true) };
  function submit(declared: ReviewDecisionDefinition): void {
    if (!gate || isClosed) return;
    const payload = selectAdjudicationPayload(state, declared.effect);
    const decision = selectAdjudicationDecision(gate, declared);
    if (!payload.ok || decision.kind !== "available") return;
    const identity = JSON.stringify({ decision: declared.definition.key, payload: payload.value });
    const key = keys.current.get(identity) ?? randomUuid();
    keys.current.set(identity, key);
    mutation.mutate({ idempotency_key: key, artifact_revision_id: decision.revision_id, action: decisionAction(decision.definition, gate.decision_definitions ?? []),
      feedback: selectBuilderPreview(state), adjudication: payload.value }, recorded);
  }
  function requestAssessmentChanges(definition: OperatorDecisionDefinition, feedback: string): void {
    if (!gate?.artifact_revision_id || isClosed || !feedback.trim()) return;
    mutation.mutate({ idempotency_key: randomUuid(), artifact_revision_id: gate.artifact_revision_id,
      action: decisionAction(definition, gate.decision_definitions ?? []), feedback }, recorded);
  }
  return { ...gateState, state, gate, isPending: mutation.isPending, error: mutation.isError ? mutation.error : null,
    choose: (action_id, choice) => setState(current => setDisposition(current, action_id, choice)),
    add: input => setState(current => addAction(current, input)),
    submit, requestAssessmentChanges };
}
