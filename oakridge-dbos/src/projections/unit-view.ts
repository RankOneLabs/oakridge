import type { ArtifactSchemaVersions } from "../storage/read-store";
import { selectInputProvenance, type InputProvenanceView } from "../domain/unit-status";
import type { BlockerHistory, BlockerRevision, BlockerAnswer, BlockerHistoryEntry } from "./history-view";
import type { ReviewHistoryEngineInputs } from "../effects/session-prompt";
import type { PinnedPrompt } from "../domain/effect-instruction";
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

/** The immutable instruction recorded when this attempt was opened. */
export interface AttemptIntentView {
  readonly input_provenance: InputProvenanceView;
  readonly inputs: BodyValue;
  readonly engine_inputs: ReviewHistoryEngineInputs;
  readonly prompt: PinnedPrompt | null;
}

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
  readonly intent: AttemptIntentView | null;
  readonly created_at: Date;
  /** The worker's latest attempt; earlier ones are superseded. */
  readonly is_current: boolean;
}
export type AttemptStatusKind = AttemptStatus["kind"];
export interface AttemptFailure { readonly code: string; readonly detail: string }

export interface ArtifactRevisionView {
  /** Identity of the pinned artifact contract, shared with observation capture. */
  readonly artifact_schema_version: string | null;
  readonly id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact_key: string;
  /** The attempt that published it, as AttemptView.id; null for an operator's edit. */
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
  readonly is_available?: boolean;
  readonly disabled_reason?: string | null;
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
  readonly blocker?: BlockerHistory | null;
  readonly input_provenance: InputProvenanceView;
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
export function selectAttemptViews(attempts: readonly AttemptRecord[], intents: RunRead["intents"] = []): readonly AttemptView[] {
  const counts = new Map<string, number>();
  const latest = selectLatestAttempts(attempts);
  const numbered = attempts.map((attempt) => {
    const number = (counts.get(selectAttemptWorkerKey(attempt)) ?? 0) + 1;
    counts.set(selectAttemptWorkerKey(attempt), number);
    return { attempt, number };
  });
  return numbered.map(({ attempt, number }) => ({ id: selectAttemptId(attempt), unit_id: attempt.unit_id,
    worker: attempt.worker, number, status: attempt.status.kind,
    failure: attempt.status.kind === "failed" ? { code: attempt.status.code, detail: attempt.status.detail } : null,
    mode: attempt.mode.kind, cause: attempt.cause, kbbl_session_id: attempt.kbbl_session_id,
    intent: selectAttemptIntent(attempt, intents),
    created_at: attempt.created_at, is_current: latest.get(selectAttemptWorkerKey(attempt)) === attempt }));
}

/** Join only the recorded action and sequence: retries must retain their own instruction. */
export function selectAttemptIntent(attempt: AttemptRecord, intents: RunRead["intents"]): AttemptIntentView | null {
  const instruction = intents.find((intent) => intent.action_id === attempt.action_id && intent.seq === attempt.seq)?.payload;
  if (!instruction) return null;
  return { input_provenance: instruction.input_provenance ?? { status: "unresolved" }, inputs: instruction.inputs as BodyValue, engine_inputs: instruction.engine_inputs,
    prompt: instruction.worker.kind === "agent" ? instruction.worker.prompt : null };
}

/** An attempt's identity: its action and that action's sequence number. */
export const selectAttemptId = (attempt: Pick<AttemptRecord, "action_id" | "seq">): string => `${attempt.action_id}:${attempt.seq}`;

/**
 * The attempt that published a revision. A revision records only its action, so this is the latest attempt of that
 * action opened by then: commit stamps both under the run lock, and a retry opens after every revision written before it.
 */
export function selectPublishingAttemptId(revision: Pick<ArtifactRevisionRecord, "by_id" | "created_at">,
  attempts: readonly Pick<AttemptRecord, "action_id" | "seq" | "created_at">[]): string | null {
  const publisher = attempts.filter((attempt) => attempt.action_id === revision.by_id && attempt.created_at.getTime() <= revision.created_at.getTime())
    .reduce<Pick<AttemptRecord, "action_id" | "seq"> | null>((latest, attempt) => latest === null || attempt.seq > latest.seq ? attempt : latest, null);
  return publisher === null ? null : selectAttemptId(publisher);
}

/** One artifact's revisions, oldest first, numbered from 1. */
export interface RevisionViewsInput {
  readonly revisions: readonly ArtifactRevisionRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly versions: ArtifactSchemaVersions;
  readonly stage: string;
}
export function selectRevisionViews({ revisions, attempts, versions, stage }: RevisionViewsInput): readonly ArtifactRevisionView[] {
  return [...revisions].sort((left, right) => left.seq - right.seq).map((revision) => ({ id: revision.id, run_id: revision.run_id, unit_id: revision.unit_id,
    artifact_schema_version: versions[stage]?.[revision.artifact] ?? null,
    artifact_key: revision.artifact, attempt_id: selectPublishingAttemptId(revision, attempts), body: revision.body as BodyValue,
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
  artifact !== "blocker" && Object.values(stage.workers).some((worker) => worker.kind === "agent" && worker.produces.includes(artifact));

function selectArtifactViews(read: RunRead, unit: UnitRecord): readonly ArtifactView[] {
  const stage = unit.stage === null ? undefined : read.definition.parsed_workflow.stages[unit.stage];
  if (!stage) return [];
  return Object.keys(stage.artifacts).sort().map((artifact) => {
    const revisions = selectRevisionViews({ revisions: revisionsOf(read.revisions, unit.id, artifact), attempts: read.attempts, versions: read.definition.artifact_schema_versions ?? {}, stage: unit.stage ?? "" });
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
      const resolved = awaiting.decisions.find((resolved) => resolved.decision === key);
      const target = resolved?.target;
      if (target === undefined) return [];
      return [{ is_available: resolved?.is_available ?? true, disabled_reason: resolved?.disabled_reason ?? null, key: decisionKey(stage, awaiting.review, key), label: decision.label, payload_schema: schemaKey(selectDecisionPayloadType(decision)),
        fields: Object.entries(decision.fields ?? {}).map(([field, label]) => ({ key: field, label })),
        submit: { kind: "review", review: awaiting.review, decision: key, effect: decision.effect, target_revision_id: target } }];
    });
  });
}
const retryDecisions = (attention: UnitAttention): readonly DecisionDefinition[] => attention.stalled.map((stalled) => ({
  is_available: true, disabled_reason: null, key: `retry:${stalled.worker}`, label: `Retry ${titleCase(stalled.worker)}`, payload_schema: schemaKey(EMPTY_PAYLOAD), fields: [],
  submit: { kind: "retry", worker: stalled.worker } }));
const CANCEL: DecisionDefinition = { is_available: true, disabled_reason: null, key: "cancel", label: "Cancel run", payload_schema: schemaKey(EMPTY_PAYLOAD), fields: [], submit: { kind: "cancel" } };

/** What the operator may decide on a unit now: its awaiting reviews' decisions, a retry per stalled worker, and cancel on a live run's root. */
export function selectAvailableDecisions(read: RunSummaryRead, unit: UnitSummaryRecord, attention: UnitAttention): readonly DecisionDefinition[] {
  const stage = unit.stage === null ? undefined : read.definition.parsed_workflow.stages[unit.stage];
  const cancel = selectUnitKey(unit) === ROOT_UNIT_KEY && !isTerminalStatus(selectRootStatus(read.run, read.units)) ? [CANCEL] : [];
  return [...(stage ? reviewDecisions(stage, attention) : []), ...retryDecisions(attention), ...cancel];
}
/** Decisions that ask for the operator: everything but the run's own cancel (part 2: counts come from asks). */
export const isAsk = (decision: DecisionDefinition): boolean => decision.submit.kind !== "cancel";

/** Narrow a unit's input to the named top-level fields. A list read repeats each
 * unit's resolved upstream artifacts, so callers name the fields they use. */
export function selectUnitInputFields(unit: UnitView, fields: readonly string[]): UnitView {
  const { input } = unit;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return unit;
  return { ...unit, input: Object.fromEntries(Object.entries(input).filter(([field]) => fields.includes(field))) };
}

export function selectUnitView(read: RunRead, unit: UnitRecord, attention: UnitAttention): UnitView {
  const tree = selectUnitTree(read.units, read.definition.workflow);
  return { unit_id: unit.id, run_id: unit.run_id, unit_key: selectUnitKey(unit), label: selectUnitLabel(unit, tree),
    blocker: selectBlockerHistory(read, unit),
    input_provenance: selectInputProvenance(unit.input_provenance),
    stage: unit.stage, collection_key: selectCollectionKey(unit), input: unit.input as BodyValue,
    depends_on: read.dependencies.filter((edge) => edge.unit_id === unit.id).map((edge) => edge.depends_on_id),
    status: unit.status, outcome: unit.status.kind === "done" ? unit.status.outcome as BodyValue : null, is_terminal: isTerminalStatus(unit.status),
    attention: selectAttention(attention, read),
    decisions: selectAvailableDecisions(read, unit, attention),
    recorded_decisions: read.decisions.filter((decision) => decision.unit_id === unit.id).map(selectRevisionDecision),
    attempts: selectAttemptViews(read.attempts.filter((attempt) => attempt.unit_id === unit.id), read.intents),
    artifacts: selectArtifactViews(read, unit) };
}

/** Bodies mirror the reserved blocker and answer schemas supplied by the core. */
interface BlockerBody { readonly text: string; readonly suggested_choices?: readonly string[] | null }
interface BlockerAnswerBody { readonly answer: string }
function isBlockerBody(body: unknown): body is BlockerBody {
  return typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
    && (!("suggested_choices" in body) || body.suggested_choices === null
      || Array.isArray(body.suggested_choices) && body.suggested_choices.every((choice: unknown) => typeof choice === "string"));
}
function isBlockerAnswerBody(body: unknown): body is BlockerAnswerBody {
  return typeof body === "object" && body !== null && "answer" in body && typeof body.answer === "string";
}

function selectBlockerHistory(read: RunRead, unit: UnitRecord): BlockerHistory | null {
  const revisions = read.revisions.filter((revision) => revision.unit_id === unit.id && revision.artifact === "blocker")
    .sort((left, right) => left.seq - right.seq).flatMap((revision): BlockerRevision[] => {
      if (!isBlockerBody(revision.body)) return [];
      return [{ revision_id: revision.id, text: revision.body.text,
        suggested_choices: revision.body.suggested_choices ?? null, created_at: revision.created_at }];
    });
  const latest = revisions.at(-1);
  if (!latest) return null;
  const decisions = read.decisions.filter((decision) => decision.unit_id === unit.id && decision.review === "blocker_review")
    .flatMap((decision): BlockerAnswer[] => {
      if (!isBlockerAnswerBody(decision.payload)) return [];
      return [{ id: decision.id, target_revision_id: decision.target_revision_id, decision: decision.decision,
        answer: decision.payload.answer, actor: decision.actor ?? null, created_at: decision.created_at }];
    });
  const history: BlockerHistoryEntry[] = [
    ...revisions.map((revision): BlockerHistoryEntry => ({ kind: "revision", revision })),
    ...decisions.map((decision): BlockerHistoryEntry => ({ kind: "decision", decision })),
  ].sort((left, right) => (left.kind === "revision" ? left.revision.created_at : left.decision.created_at).getTime()
    - (right.kind === "revision" ? right.revision.created_at : right.decision.created_at).getTime());
  return { is_open: unit.blocked_reason?.kind === "blocker", available_decisions: unit.review_prompts?.blocker_review?.decisions ?? [], latest, revisions, decisions, history };
}
