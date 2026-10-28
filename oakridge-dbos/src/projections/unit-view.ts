import type { AttemptStatus, Cause, DeclaredDecisionEffect, Mode, ParsedReview, ParsedStage, UnitStatus } from "../core-client/core-types";
import type { JsonValue, RunId, UnitId } from "../domain/primitives";
import { isTerminalStatus, selectRootStatus } from "../domain/unit-status";
import type { RevisionRef, RunRead, RunSummaryRead, UnitSummaryRecord } from "../storage/read-store";
import type { ArtifactRevisionRecord, AttemptRecord, ReviewDecisionRecord, UnitRecord } from "../storage/schema-records";
import { selectAttemptWorkerKey, selectAttention, selectLatestAttempts, type Attention, type UnitAttention } from "./attention";
import { EMPTY_PAYLOAD, schemaKey, selectDecisionPayloadType, typeSchemaKey } from "./schema-view";
import { ROOT_UNIT_KEY, selectCollectionKey, selectUnitKey, selectUnitLabel, selectUnitTree, titleCase } from "./unit-label";

/** Artifact bodies, unit inputs and outcomes, and decision payloads are plain JSON. */
export type BodyValue = JsonValue;

/** One attempt of a worker on its unit. */
export interface AttemptView {
  /** Opaque: `<action id>:<seq>`. Show the worker, mode and cause instead. */
  readonly id: string;
  readonly unit_id: UnitId;
  readonly worker: string;
  /** The attempt's position among its worker's attempts on the unit, from 1, in the order commit opened them. */
  readonly number: number;
  readonly status: AttemptStatusKind;
  readonly failure: AttemptFailure | null;
  readonly mode: Mode["kind"];
  readonly cause: Cause;
  readonly kbbl_session_id: string | null;
  readonly created_at: Date;
  /** The worker's latest attempt; earlier ones are superseded. */
  readonly is_current: boolean;
}
export type AttemptStatusKind = AttemptStatus["kind"];
export interface AttemptFailure { readonly code: string; readonly detail: string }

export interface ArtifactRevisionView {
  readonly id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact_key: string;
  /** The attempt that published it; null for an operator's edit. */
  readonly attempt_id: string | null;
  readonly body: BodyValue;
  readonly predecessor_id: string | null;
  /** The revision a review artifact reviews. */
  readonly subject_id: string | null;
  readonly created_at: Date;
  /** The revision's position in its artifact, from 1. */
  readonly number: number;
}
/** One artifact a unit's stage declares, with its latest revision. */
export interface ArtifactView {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact_key: string;
  /** The schema name the PWA's viewer registry dispatches on. */
  readonly schema: string;
  /** An operator review of this artifact is declared. */
  readonly is_reviewable: boolean;
  /** An agent creates it, so the operator may publish an edited revision. */
  readonly is_editable: boolean;
  readonly revision_count: number;
  readonly latest_revision: ArtifactRevisionView | null;
}

/** What a decision submits: a review's decision on its target revision, a stalled worker's retry, or the run's cancel. */
export type DecisionSubmit =
  | { readonly kind: "review"; readonly review: string; readonly decision: string; readonly effect: DeclaredDecisionEffect; readonly target_revision_id: string }
  | { readonly kind: "retry"; readonly worker: string }
  | { readonly kind: "cancel" };
export interface DecisionField { readonly key: string; readonly label: string }
/** One decision the operator can make on a unit now. */
export interface DecisionDefinition {
  /** Unique within the unit: the decision key, `<review>:<decision>` where a stage reuses a key across reviews, `retry:<worker>`, or `cancel`. */
  readonly key: string;
  readonly label: string;
  readonly payload_schema: string;
  /** Labels for the payload's text fields. */
  readonly fields: readonly DecisionField[];
  readonly submit: DecisionSubmit;
}

/** A decision recorded on one of a unit's artifact revisions. */
export interface RevisionDecision {
  readonly id: string;
  readonly review: string;
  readonly decision: string;
  readonly effect: DeclaredDecisionEffect;
  readonly target_revision_id: string;
  readonly payload: BodyValue;
  readonly created_at: Date;
}
export const selectRevisionDecision = (decision: ReviewDecisionRecord): RevisionDecision => ({
  id: decision.id, review: decision.review, decision: decision.decision, effect: decision.effect,
  target_revision_id: decision.target_revision_id, payload: decision.payload as BodyValue, created_at: decision.created_at });

export interface UnitView {
  readonly unit_id: UnitId;
  readonly run_id: RunId;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly collection_key: string | null;
  readonly input: BodyValue;
  readonly depends_on: readonly UnitId[];
  readonly status: UnitStatus;
  readonly outcome: BodyValue | null;
  readonly is_terminal: boolean;
  readonly attention: Attention | null;
  readonly decisions: readonly DecisionDefinition[];
  /** Decisions already made on the unit's revisions, oldest first. */
  readonly recorded_decisions: readonly RevisionDecision[];
  readonly attempts: readonly AttemptView[];
  readonly artifacts: readonly ArtifactView[];
}

/** Attempts, oldest first, each numbered among its worker's attempts on its unit. */
export function selectAttemptViews(attempts: readonly AttemptRecord[]): readonly AttemptView[] {
  const counts = new Map<string, number>();
  const latest = selectLatestAttempts(attempts);
  const numbered = attempts.map((attempt) => {
    const number = (counts.get(selectAttemptWorkerKey(attempt)) ?? 0) + 1;
    counts.set(selectAttemptWorkerKey(attempt), number);
    return { attempt, number };
  });
  return numbered.map(({ attempt, number }) => ({ id: `${attempt.action_id}:${attempt.seq}`, unit_id: attempt.unit_id,
    worker: attempt.worker, number, status: attempt.status.kind,
    failure: attempt.status.kind === "failed" ? { code: attempt.status.code, detail: attempt.status.detail } : null,
    mode: attempt.mode.kind, cause: attempt.cause, kbbl_session_id: attempt.kbbl_session_id,
    created_at: attempt.created_at, is_current: latest.get(selectAttemptWorkerKey(attempt)) === attempt }));
}

/** One artifact's revisions, oldest first, numbered from 1. */
export function selectRevisionViews(revisions: readonly ArtifactRevisionRecord[]): readonly ArtifactRevisionView[] {
  return [...revisions].sort((left, right) => left.seq - right.seq).map((revision) => ({ id: revision.id, run_id: revision.run_id, unit_id: revision.unit_id,
    artifact_key: revision.artifact, attempt_id: revision.by_id, body: revision.body as BodyValue,
    predecessor_id: revision.predecessor_id, subject_id: revision.subject, created_at: revision.created_at, number: revision.seq }));
}
const revisionsOf = <Revision extends RevisionRef>(revisions: readonly Revision[], unit_id: string, artifact: string): readonly Revision[] =>
  revisions.filter((revision) => revision.unit_id === unit_id && revision.artifact === artifact);

/** The schema name of an artifact's body: its alias where it names one. */
export const selectArtifactSchema = (stage: ParsedStage, artifact: string): string => {
  const declared = stage.artifacts[artifact];
  return declared ? typeSchemaKey(declared.schema) : "";
};
/** An operator review has `of` this artifact; an engine review decides by itself and asks no one. */
export const isReviewable = (stage: ParsedStage, artifact: string): boolean =>
  Object.values(stage.reviews ?? {}).some((review) => review.of === artifact && review.by === "operator");
/** The core refuses an operator's edit of an artifact a code worker creates. */
export const isEditable = (stage: ParsedStage, artifact: string): boolean =>
  Object.values(stage.workers).some((worker) => worker.kind === "agent" && worker.creates.includes(artifact));

function selectArtifactViews(read: RunRead, unit: UnitRecord): readonly ArtifactView[] {
  const stage = unit.stage === null ? undefined : read.definition.parsed_workflow.stages[unit.stage];
  if (!stage) return [];
  return Object.keys(stage.artifacts).sort().map((artifact) => {
    const revisions = selectRevisionViews(revisionsOf(read.revisions, unit.id, artifact));
    return { run_id: unit.run_id, unit_id: unit.id, artifact_key: artifact, schema: selectArtifactSchema(stage, artifact),
      is_reviewable: isReviewable(stage, artifact), is_editable: isEditable(stage, artifact),
      revision_count: revisions.length, latest_revision: revisions.at(-1) ?? null };
  });
}

/** A decision key reused by two reviews of one stage is qualified by its review, so keys stay unique per unit. */
function decisionKey(stage: ParsedStage, review: string, decision: string): string {
  const reuses = Object.values(stage.reviews ?? {}).filter((candidate) => decision in candidate.decisions).length;
  return reuses > 1 ? `${review}:${decision}` : decision;
}

function reviewDecisions(stage: ParsedStage, attention: UnitAttention): readonly DecisionDefinition[] {
  return attention.awaiting.flatMap((awaiting) => {
    const review: ParsedReview | undefined = stage.reviews?.[awaiting.review];
    if (!review) return [];
    return Object.entries(review.decisions).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, decision]) => {
      // The core names each decision's target; a decision it does not list is not legal now.
      const target = awaiting.decisions.find((resolved) => resolved.decision === key)?.target;
      if (target === undefined) return [];
      return [{ key: decisionKey(stage, awaiting.review, key), label: decision.label, payload_schema: schemaKey(selectDecisionPayloadType(decision)),
        fields: Object.entries(decision.fields ?? {}).map(([field, label]) => ({ key: field, label })),
        submit: { kind: "review", review: awaiting.review, decision: key, effect: decision.effect, target_revision_id: target } }];
    });
  });
}
const retryDecisions = (attention: UnitAttention): readonly DecisionDefinition[] => attention.stalled.map((stalled) => ({
  key: `retry:${stalled.worker}`, label: `Retry ${titleCase(stalled.worker)}`, payload_schema: schemaKey(EMPTY_PAYLOAD), fields: [],
  submit: { kind: "retry", worker: stalled.worker } }));
const CANCEL: DecisionDefinition = { key: "cancel", label: "Cancel run", payload_schema: schemaKey(EMPTY_PAYLOAD), fields: [], submit: { kind: "cancel" } };

/** What the operator may decide on a unit now: its awaiting reviews' decisions, a retry per stalled worker, and cancel on a live run's root. */
export function selectAvailableDecisions(read: RunSummaryRead, unit: UnitSummaryRecord, attention: UnitAttention): readonly DecisionDefinition[] {
  const stage = unit.stage === null ? undefined : read.definition.parsed_workflow.stages[unit.stage];
  const cancel = selectUnitKey(unit) === ROOT_UNIT_KEY && !isTerminalStatus(selectRootStatus(read.run, read.units)) ? [CANCEL] : [];
  return [...(stage ? reviewDecisions(stage, attention) : []), ...retryDecisions(attention), ...cancel];
}
/** Decisions that ask for the operator: everything but the run's own cancel (part 2: counts come from asks). */
export const isAsk = (decision: DecisionDefinition): boolean => decision.submit.kind !== "cancel";

export function selectUnitView(read: RunRead, unit: UnitRecord, attention: UnitAttention): UnitView {
  const tree = selectUnitTree(read.units, read.definition.workflow);
  return { unit_id: unit.id, run_id: unit.run_id, unit_key: selectUnitKey(unit), label: selectUnitLabel(unit, tree),
    stage: unit.stage, collection_key: selectCollectionKey(unit), input: unit.input as BodyValue,
    depends_on: read.dependencies.filter((edge) => edge.unit_id === unit.id).map((edge) => edge.depends_on_id),
    status: unit.status, outcome: unit.status.kind === "done" ? unit.status.outcome as BodyValue : null, is_terminal: isTerminalStatus(unit.status),
    attention: selectAttention(attention, read),
    decisions: selectAvailableDecisions(read, unit, attention),
    recorded_decisions: read.decisions.filter((decision) => decision.unit_id === unit.id).map(selectRevisionDecision),
    attempts: selectAttemptViews(read.attempts.filter((attempt) => attempt.unit_id === unit.id)),
    artifacts: selectArtifactViews(read, unit) };
}
