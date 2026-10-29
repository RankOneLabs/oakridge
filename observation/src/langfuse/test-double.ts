import { err, ok, type Result } from "../domain/primitives";
import type { EvaluationBackend, ExternalTargetIds, FetchSelector, InboundEvaluation, LangfuseError,
  LangfuseObservationId, LangfuseQueueItemId, LangfuseScoreId, LangfuseTraceId, ProjectionInput,
  ReconcileOutcome, ReconcileSelector } from "../ports/evaluation-backend";
import { mappingKey } from "./mapping";
import { encodeProjection, type ProjectionShape } from "./projection";

interface ProjectedFixture {
  readonly external_ids: ExternalTargetIds;
  readonly shape: ProjectionShape;
  readonly occurrence_id: string;
  readonly question_id: string;
  readonly question_version: string;
}
const EMPTY_INBOUND: InboundEvaluation = { scores: [], annotation_outcomes: [] };

function sameTargets(left: ExternalTargetIds, right: ExternalTargetIds): boolean {
  return left.trace_id === right.trace_id && left.observation_id === right.observation_id
    && left.score_id === right.score_id && left.queue_item_id === right.queue_item_id;
}

/** Deterministic in-memory adapter for contract tests; it has no provider or storage access. */
export class TestEvaluationBackend implements EvaluationBackend {
  private readonly projected = new Map<string, ProjectedFixture>();
  private readonly inbound = new Map<string, InboundEvaluation>();

  getProjection(mapping_key: string): ProjectionShape | null {
    return this.projected.get(mapping_key)?.shape ?? null;
  }

  setInbound(mapping_key: string, value: InboundEvaluation): void {
    this.inbound.set(mapping_key, value);
  }

  async project(input: ProjectionInput): Promise<Result<ExternalTargetIds, LangfuseError>> {
    const shape = encodeProjection(input);
    if (!shape.ok) return shape;
    const identity = mappingKey({ occurrence_id: input.execution.subject_occurrence_id, evidence: input.evidence,
      question_id: input.question.question_id, question_version: input.question.question_version,
      projection_version: input.projection_version });
    if (!identity.ok) return identity;
    const existing = this.projected.get(identity.value.mapping_key);
    if (existing) return ok(existing.external_ids);
    const digest = identity.value.mapping_key.slice("canonical-json/v1:".length);
    const external_ids: ExternalTargetIds = { trace_id: `trace-${digest}` as LangfuseTraceId,
      observation_id: `observation-${digest}` as LangfuseObservationId,
      score_id: `score-${digest}` as LangfuseScoreId, queue_item_id: `queue-${digest}` as LangfuseQueueItemId };
    this.projected.set(identity.value.mapping_key, { external_ids, shape: shape.value,
      occurrence_id: input.execution.subject_occurrence_id, question_id: input.question.question_id,
      question_version: input.question.question_version });
    return ok(external_ids);
  }

  async fetch(selector: FetchSelector): Promise<Result<InboundEvaluation, LangfuseError>> {
    const projected = this.projected.get(selector.mapping_key);
    if (!projected || !sameTargets(projected.external_ids, selector.external_ids))
      return err({ operation: "fetch", entity_id: selector.mapping_key, detail: "mapping is not authenticated" });
    return ok(this.inbound.get(selector.mapping_key) ?? EMPTY_INBOUND);
  }

  async reconcile(selector: ReconcileSelector): Promise<Result<ReconcileOutcome, LangfuseError>> {
    const projected = this.projected.get(selector.mapping_key);
    if (!projected) return err({ operation: "reconcile", entity_id: selector.mapping_key, detail: "mapping is not found" });
    if (projected.occurrence_id !== selector.occurrence_id || projected.question_id !== selector.question_id
      || projected.question_version !== selector.question_version
      || (selector.external_ids !== null && !sameTargets(projected.external_ids, selector.external_ids)))
      return err({ operation: "reconcile", entity_id: selector.mapping_key, detail: "mapping is not authenticated" });
    const inbound = this.inbound.get(selector.mapping_key) ?? EMPTY_INBOUND;
    const sync_state = inbound.scores.length || inbound.annotation_outcomes.some((item) => item.status === "completed")
      ? { status: "completed" as const, mapping_key: selector.mapping_key, completed_at: "1970-01-01T00:00:00.000Z" }
      : { status: "pending" as const, mapping_key: selector.mapping_key, last_checked_at: "1970-01-01T00:00:00.000Z" };
    return ok({ external_ids: projected.external_ids, inbound, sync_state });
  }
}
