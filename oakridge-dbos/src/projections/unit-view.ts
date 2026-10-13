import type { Cause, Mode, Review, ReviewDecision, Stage, UnitStatus } from "../core-client/core-types";
import type { JsonValue, RunId, UnitId } from "../domain/primitives";
import type { RunRead } from "../storage/read-store";
import type { ArtifactRevisionRecord, AttemptRecord, UnitRecord } from "../storage/schema-records";
import { selectAttention, type Attention, type UnitAttention } from "./attention";
import { EMPTY_PAYLOAD, schemaKey, selectDecisionPayloadType, typeSchemaKey } from "./schema-view";
import { ROOT_UNIT_KEY, selectUnitLabel, titleCase } from "./unit-label";

/**
 * The unit read model (v1 `ScopeView`, renamed per rescue spec §2.3). Bodies,
 * inputs and payloads are plain JSON (`BodyValue`, v1 `CheckedValue`).
 */
export type BodyValue = JsonValue;
/** v1 `ProjectionCursor`; `transition_id` is removed (R4 decision, part 1 §12). */
export interface UnitCursor { readonly unit_version: number }

/** v1 `ExecutionView`: one attempt of a worker on its unit. */
export interface AttemptView {
  /** Opaque: `<action id>:<seq>`. Show the worker, mode and cause instead. */
  readonly id: string;
  readonly unit_id: UnitId;
  readonly worker_key: string;
  /** The attempt's position among its worker's attempts on the unit, from 1, in the order commit opened them. */
  readonly generation: number;
  readonly status: AttemptStatusKind;
  readonly result: AttemptFailure | null;
  /** The attempt's seq within its action (a periodic worker's attempts share one action). */
  readonly version: number;
  readonly mode: Mode["kind"];
  readonly cause: Cause;
  readonly kbbl_session_id: string | null;
  readonly created_at: Date;
  /** The worker's latest attempt; earlier ones are superseded. */
  readonly is_current: boolean;
}
export type AttemptStatusKind = AttemptRecord["status"]["kind"];
export interface AttemptFailure { readonly code: string; readonly detail: string }

/** v1 `ArtifactRevisionRecord`. */
export interface ArtifactRevisionView {
  readonly id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  /** The action whose attempt published it; null for an operator's edit (D2). */
  readonly attempt_id: string | null;
  readonly artifact_key: string;
  /** Every v2 artifact is single per unit: always "". */
  readonly collection_key: string;
  readonly body: BodyValue;
  readonly predecessor_id: string | null;
  /** The revision a review artifact reviews. */
  readonly subject_id: string | null;
  readonly created_at: Date;
  /** The revision's position in its artifact, from 1. */
  readonly version: number;
}
/** v1 `OutputSlotView`: one declared artifact of the unit's stage and its latest revision. */
export interface ArtifactView {
  /** `<unit id>:<artifact key>`. */
  readonly id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact_key: string;
  readonly collection_key: string;
  readonly latest_revision_id: string | null;
  /** How many revisions the artifact has. */
  readonly version: number;
  readonly latest_revision: ArtifactRevisionView | null;
  /** The resolved schema name the PWA's viewer registry dispatches on (§3.1). */
  readonly schema: string;
  /** A review of this artifact is declared (§3.1). */
  readonly reviewable: boolean;
}

/** Where a decision is submitted: a review's decide route, a worker's retry, or the run's cancel. */
export type DecisionSubmit =
  | { readonly kind: "review"; readonly review: string }
  | { readonly kind: "retry"; readonly worker: string }
  | { readonly kind: "cancel" };
/** v1's command target expression, narrowed to the one form v2 has: the latest revision of an artifact. */
export interface DecisionTarget { readonly kind: "reference"; readonly root: { readonly kind: "artifact"; readonly key: string }; readonly path: readonly string[] }
export interface DecisionFieldPresentation { readonly key: string; readonly presentation: { readonly label: string } }
/** v1 `CommandDefinition`: one decision available to the operator now. */
export interface DecisionDefinition {
  /** Unique within the unit: the decision key, `<review>:<decision>` where a stage reuses a key across reviews, `retry:<worker>`, or `cancel`. */
  readonly key: string;
  readonly label: string;
  readonly consequence: string;
  readonly payload_schema: string;
  readonly targets: readonly DecisionTarget[];
  /** v2 decisions declare no prefill; the target revision rides in `decision_targets`. */
  readonly prefill: readonly { readonly key: string }[];
  readonly field_presentation: readonly DecisionFieldPresentation[];
  readonly submit: DecisionSubmit;
}
/** v1 `TargetRevision`: the revision a decision is made on. */
export interface TargetRevision { readonly identity: string; readonly version: number }
export type DecisionPrefill = Readonly<{ readonly [field_key: string]: BodyValue }>;

export interface UnitView {
  readonly unit_id: UnitId;
  readonly run_id: RunId;
  readonly unit_key: string;
  readonly label: string;
  readonly stage: string | null;
  readonly collection_key: string | null;
  readonly input: BodyValue;
  readonly depends_on: readonly UnitId[];
  /** v1's scope state: the unit's status. */
  readonly state: UnitStatus;
  readonly outcome: BodyValue | null;
  readonly is_terminal: boolean;
  readonly decisions: readonly DecisionDefinition[];
  readonly attempts: readonly AttemptView[];
  readonly artifacts: readonly ArtifactView[];
  readonly decision_targets: Readonly<{ readonly [decision_key: string]: readonly TargetRevision[] }>;
  readonly decision_prefill: Readonly<{ readonly [decision_key: string]: DecisionPrefill }>;
  /** Derived attention under its v1 name (R4 decision, part 1 §12). */
  readonly decision: Attention | null;
  readonly cursor: UnitCursor;
}
/** v1 `Decision`: the unit's attention line alone. */
export interface Decision { readonly decision: Attention | null; readonly cursor: UnitCursor }

export const isTerminalStatus = (status: UnitStatus): boolean => status.kind === "done" || status.kind === "cancelled";

/** Attempts, oldest first, each numbered among its worker's attempts on its unit. */
export function selectAttemptViews(attempts: readonly AttemptRecord[]): readonly AttemptView[] {
  const counts = new Map<string, number>();
  const workerOf = (attempt: AttemptRecord): string => `${attempt.unit_id}:${attempt.worker}`;
  const numbered = attempts.map((attempt) => {
    const generation = (counts.get(workerOf(attempt)) ?? 0) + 1;
    counts.set(workerOf(attempt), generation);
    return { attempt, generation };
  });
  return numbered.map(({ attempt, generation }) => ({ id: `${attempt.action_id}:${attempt.seq}`, unit_id: attempt.unit_id,
    worker_key: attempt.worker, generation, status: attempt.status.kind,
    result: attempt.status.kind === "failed" ? { code: attempt.status.code, detail: attempt.status.detail } : null,
    version: attempt.seq, mode: attempt.mode.kind, cause: attempt.cause, kbbl_session_id: attempt.kbbl_session_id,
    created_at: attempt.created_at, is_current: generation === counts.get(workerOf(attempt)) }));
}

/** One artifact's revisions, oldest first, numbered from 1. */
export function selectRevisionViews(revisions: readonly ArtifactRevisionRecord[]): readonly ArtifactRevisionView[] {
  return revisions.map((revision, index) => ({ id: revision.id, run_id: revision.run_id, unit_id: revision.unit_id,
    attempt_id: revision.by_id, artifact_key: revision.artifact, collection_key: "", body: revision.body as BodyValue,
    predecessor_id: revision.predecessor_id, subject_id: revision.subject, created_at: revision.created_at, version: index + 1 }));
}
const revisionsOf = (read: RunRead, unit_id: string, artifact: string): readonly ArtifactRevisionRecord[] =>
  read.revisions.filter((revision) => revision.unit_id === unit_id && revision.artifact === artifact);

/** The schema name of an artifact's body: its alias where it names one (§3.1). */
export const selectArtifactSchema = (stage: Stage, artifact: string): string => {
  const declared = stage.artifacts[artifact];
  return declared ? typeSchemaKey(declared.schema) : "";
};
/** An operator review has `of` this artifact; an engine review decides by itself and asks no one. */
export const isReviewable = (stage: Stage, artifact: string): boolean =>
  Object.values(stage.reviews ?? {}).some((review) => review.of === artifact && review.by === "operator");

function selectArtifactViews(read: RunRead, unit: UnitRecord): readonly ArtifactView[] {
  const stage = unit.stage === null ? undefined : read.definition.workflow.stages[unit.stage];
  if (!stage) return [];
  return Object.keys(stage.artifacts).sort().map((artifact) => {
    const revisions = selectRevisionViews(revisionsOf(read, unit.id, artifact));
    const latest = revisions.at(-1) ?? null;
    return { id: `${unit.id}:${artifact}`, run_id: unit.run_id, unit_id: unit.id, artifact_key: artifact, collection_key: "",
      latest_revision_id: latest?.id ?? null, version: revisions.length, latest_revision: latest,
      schema: selectArtifactSchema(stage, artifact), reviewable: isReviewable(stage, artifact) };
  });
}

/** A decision key reused by two reviews of one stage is qualified by its review, so keys stay unique per unit. */
function decisionKey(stage: Stage, review: string, decision: string): string {
  const reuses = Object.values(stage.reviews ?? {}).filter((candidate) => decision in candidate.decisions).length;
  return reuses > 1 ? `${review}:${decision}` : decision;
}
/** v1 consequences were short verb phrases ("accept", "request changes", "admit"); a v2 decision's label, lower-cased. */
const consequenceOf = (decision: ReviewDecision): string =>
  decision.label.trim() === "" ? decision.effect.replace("_", " ") : decision.label.trim().toLowerCase();

export interface AvailableDecision { readonly definition: DecisionDefinition; readonly targets: readonly TargetRevision[] }

function reviewDecisions(read: RunRead, unit: UnitRecord, stage: Stage, attention: UnitAttention): readonly AvailableDecision[] {
  return attention.awaiting.flatMap((awaiting) => {
    const review: Review | undefined = stage.reviews?.[awaiting.review];
    if (!review) return [];
    return Object.entries(review.decisions).sort(([left], [right]) => left.localeCompare(right)).map(([key, decision]) => {
      const artifact = decision.on ?? review.of;
      // The review's target is its `of` revision; a decision `on` another artifact decides that artifact's latest.
      const revisions = selectRevisionViews(revisionsOf(read, unit.id, artifact));
      const target = decision.on == null ? revisions.find((revision) => revision.id === awaiting.target) : revisions.at(-1);
      return { definition: { key: decisionKey(stage, awaiting.review, key), label: decision.label, consequence: consequenceOf(decision),
        payload_schema: schemaKey(selectDecisionPayloadType(decision)), targets: [{ kind: "reference", root: { kind: "artifact", key: artifact }, path: [] }],
        prefill: [], field_presentation: Object.entries(decision.fields ?? {}).map(([field, label]) => ({ key: field, presentation: { label } })),
        submit: { kind: "review", review: awaiting.review } },
        targets: target ? [{ identity: target.id, version: target.version }] : [] };
    });
  });
}
const retryDecisions = (attention: UnitAttention): readonly AvailableDecision[] => attention.stalled.map((stalled) => ({
  definition: { key: `retry:${stalled.worker}`, label: `Retry ${titleCase(stalled.worker)}`, consequence: "retry", payload_schema: schemaKey(EMPTY_PAYLOAD),
    targets: [], prefill: [], field_presentation: [], submit: { kind: "retry", worker: stalled.worker } }, targets: [] }));
const CANCEL: AvailableDecision = { definition: { key: "cancel", label: "Cancel run", consequence: "cancel", payload_schema: schemaKey(EMPTY_PAYLOAD),
  targets: [], prefill: [], field_presentation: [], submit: { kind: "cancel" } }, targets: [] };

/** What the operator may decide on a unit now: its awaiting reviews' decisions, a retry per stalled worker, and cancel on a live run's root. */
export function selectAvailableDecisions(read: RunRead, unit: UnitRecord, attention: UnitAttention): readonly AvailableDecision[] {
  const stage = unit.stage === null ? undefined : read.definition.workflow.stages[unit.stage];
  const cancel = unit.unit_key === ROOT_UNIT_KEY && !isTerminalStatus(read.run.status) ? [CANCEL] : [];
  return [...(stage ? reviewDecisions(read, unit, stage, attention) : []), ...retryDecisions(attention), ...cancel];
}
/** Decisions that ask for the operator: everything but the run's own cancel (part 2: counts come from asks). */
export const isAsk = (decision: DecisionDefinition): boolean => decision.submit.kind !== "cancel";

export function selectUnitView(read: RunRead, unit: UnitRecord, attention: UnitAttention): UnitView {
  const available = selectAvailableDecisions(read, unit, attention);
  return { unit_id: unit.id, run_id: unit.run_id, unit_key: unit.unit_key, label: selectUnitLabel(unit, read.definition.workflow),
    stage: unit.stage, collection_key: unit.collection_key, input: unit.input as BodyValue,
    depends_on: read.dependencies.filter((edge) => edge.unit_id === unit.id).map((edge) => edge.depends_on_id),
    state: unit.status, outcome: unit.status.kind === "done" ? unit.status.outcome as BodyValue : null, is_terminal: isTerminalStatus(unit.status),
    decisions: available.map((item) => item.definition),
    attempts: selectAttemptViews(read.attempts.filter((attempt) => attempt.unit_id === unit.id)),
    artifacts: selectArtifactViews(read, unit),
    decision_targets: Object.fromEntries(available.map((item) => [item.definition.key, item.targets])),
    decision_prefill: Object.fromEntries(available.map((item) => [item.definition.key, {}])),
    decision: selectAttention(attention, read), cursor: { unit_version: unit.version } };
}

export const selectDecision = (view: UnitView): Decision => ({ decision: view.decision, cursor: view.cursor });
