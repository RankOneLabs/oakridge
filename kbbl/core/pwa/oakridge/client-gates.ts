import type { OperatorDecideRequest } from "./operator-contracts/http/ingress";
import type { OperatorRunView } from "./operator-contracts/projections/run-view";
import type { OperatorUnitView } from "./operator-contracts/projections/unit-view";
import type { GateResumeRequest, GateResumeResponse, MergeStatus, ParkedGate, SentReviewFeedback } from "./artifact-types";
import { compositeId, decisionAction, parseCompositeId, reviewToGates, sentReviewFeedback, unwrap as unwrapAdapter, type CompositeId } from "./adapters/core";
import { isAdjudicationDecision } from "./adapters/gates";
import { parseUnitView } from "./adapters/parse";

interface GateClientContext {
  readRunPage: (isArchived?: boolean) => Promise<OperatorRunView[]>;
  readUnits: (runId: string) => Promise<readonly OperatorUnitView[]>;
  unitPath: (runId: string, unitId: string) => string;
  get: <T>(path: string) => Promise<T>;
  decide: (runId: string, unitId: string, review: string, request: OperatorDecideRequest) => Promise<string>;
  invalidateCachedRunUnits: (runId: string | null) => void;
}

export function createGateClient({ readRunPage, readUnits, unitPath, get, decide, invalidateCachedRunUnits }: GateClientContext) {
  async function resolveGateId(id: string, request: GateResumeRequest): Promise<CompositeId> {
    const parsed = parseCompositeId(id, "gate");
    if (parsed.ok) return parsed.value;
    const revision = parseCompositeId(request.artifact_revision_id, "artifact");
    const target = revision.ok ? revision.value.name.slice(revision.value.name.indexOf(":") + 1) : request.artifact_revision_id;
    const matches: CompositeId[] = [];
    for (const run of await readRunPage()) for (const unit of await readUnits(run.run_id)) {
      const reviews = new Set(unit.reviews.filter((review) => review.reviewed_revision_id === target).map((review) => review.review));
      for (const review of reviews) if (unit.decisions.some((decision) => decision.submit.kind === "review"
        && decision.submit.review === review && decisionAction(decision, unit.decisions) === request.action)) {
        matches.push({ kind: "gate", runId: run.run_id, unitId: unit.unit_id, name: JSON.stringify([review, target]) });
      }
    }
    if (matches.length !== 1) throw new Error(`oakridge ${id}: opaque gate ${matches.length === 0 ? "not found" : "is ambiguous"}`);
    return matches[0];
  }
  async function fetchRunGates(runId: string): Promise<ParkedGate[]> {
    return (await readUnits(runId)).flatMap((unit) => unwrapAdapter(unitPath(runId, unit.unit_id), reviewToGates(unit)));
  }

  async function fetchRunSentFeedback(runId: string): Promise<SentReviewFeedback[]> {
    return (await readUnits(runId)).flatMap(sentReviewFeedback);
  }

  async function fetchGates(): Promise<ParkedGate[]> {
    const runs = await readRunPage();
    return (await Promise.all(runs.map((run) => fetchRunGates(run.run_id)))).flat();
  }

  async function resumeGate(gateId: string, req: GateResumeRequest): Promise<GateResumeResponse> {
    const gate = await resolveGateId(gateId, req);
    const path = unitPath(gate.runId, gate.unitId);
    const unit = unwrapAdapter(path, parseUnitView(await get<unknown>(path)));
    const currentGate = unwrapAdapter(path, reviewToGates(unit)).find((candidate) => candidate.id === compositeId(gate));
    const review = currentGate?.gate_step;
    if (!review) throw new Error(`oakridge ${gateId}: review unavailable`);
    const requestedRevision = parseCompositeId(req.artifact_revision_id, "artifact");
    const requestedTarget = requestedRevision.ok
      ? requestedRevision.value.name.slice(requestedRevision.value.name.indexOf(":") + 1) : req.artifact_revision_id;
    if (!currentGate?.reviewed_revision_id || requestedTarget !== currentGate.reviewed_revision_id)
      throw new Error(`oakridge ${gateId}: review artifact changed; refresh before deciding`);
    const decision = unit.decisions.find((candidate) => candidate.submit.kind === "review" && candidate.submit.review === review
      && !isAdjudicationDecision(candidate) && decisionAction(candidate, unit.decisions) === req.action);
    if (!decision || decision.submit.kind !== "review") throw new Error(`oakridge ${gateId}: decision ${req.action} unavailable`);
    if (decision.is_available === false)
      throw new Error(`oakridge ${gateId}: ${decision.disabled_reason ?? `decision ${req.action} unavailable`}`);
    if (decision.fields.length > 1)
      throw new Error(`oakridge ${gateId}: decision requires unsupported fields`);
    if (decision.submit.effect === "request_changes" && decision.fields.length === 0 && req.feedback.trim())
      throw new Error(`oakridge ${gateId}: decision does not accept feedback`);
    const field = decision.fields[0];
    const payload = field ? { [field.key]: req.feedback } : {};
    await decide(gate.runId, gate.unitId, review, { decision: decision.submit.decision, target: decision.submit.target_revision_id, payload, request_id: req.idempotency_key });
    invalidateCachedRunUnits(gate.runId);
    return { gate_id: gateId, resumed: true };
  }

  /** Read the forge at click time for the current PR of a cohort or integration unit. */
  function fetchMergeStatus(gateId: string): Promise<MergeStatus> {
    const gate = unwrapAdapter(gateId, parseCompositeId(gateId, "gate"));
    return get<MergeStatus>(`${unitPath(gate.runId, gate.unitId)}/merge-status`);
  }

  return { fetchRunGates, fetchRunSentFeedback, fetchGates, resumeGate, fetchMergeStatus };
}
