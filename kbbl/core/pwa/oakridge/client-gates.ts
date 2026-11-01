import type { OperatorRunView, OperatorUnitView } from "./operator-contracts";
import type { GateResumeRequest, GateResumeResponse, MergeStatus, ParkedGate, SentReviewFeedback } from "./types";
import { decisionAction, parseCompositeId, reviewToGates, sentReviewFeedback, unwrap as unwrapAdapter, type CompositeId } from "./adapters/core";
import { parseUnitView } from "./adapters/parse";

interface GateClientContext {
  readRunPage: (isArchived?: boolean) => Promise<OperatorRunView[]>;
  readUnits: (runId: string) => Promise<readonly OperatorUnitView[]>;
  unitPath: (runId: string, unitId: string) => string;
  get: <T>(path: string) => Promise<T>;
  decide: (runId: string, unitId: string, review: string, decision: string, target: string, payload: unknown, requestId: string) => Promise<string>;
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
      const reviews = new Set(unit.decisions.flatMap((decision) => decision.submit.kind === "review"
        && decision.submit.target_revision_id === target ? [decision.submit.review] : []));
      for (const review of reviews) if (unit.decisions.some((decision) => decision.submit.kind === "review"
        && decision.submit.review === review && decisionAction(decision) === request.action)) {
        matches.push({ kind: "gate", runId: run.run_id, unitId: unit.unit_id, name: review });
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
    const review = gate.name.split(":", 1)[0];
    const path = unitPath(gate.runId, gate.unitId);
    const unit = unwrapAdapter(path, parseUnitView(await get<unknown>(path)));
    const currentGate = unwrapAdapter(path, reviewToGates(unit)).find((candidate) => candidate.id === gateId
      || (candidate.run_id === gate.runId && candidate.gate_step === review));
    const requestedRevision = parseCompositeId(req.artifact_revision_id, "artifact");
    const currentRevision = currentGate?.artifact_revision_id
      ? parseCompositeId(currentGate.artifact_revision_id, "artifact") : null;
    const requestedTarget = requestedRevision.ok
      ? requestedRevision.value.name.slice(requestedRevision.value.name.indexOf(":") + 1) : req.artifact_revision_id;
    const currentTarget = currentRevision?.ok
      ? currentRevision.value.name.slice(currentRevision.value.name.indexOf(":") + 1) : currentGate?.artifact_revision_id;
    if (!currentTarget || requestedTarget !== currentTarget)
      throw new Error(`oakridge ${gateId}: review artifact changed; refresh before deciding`);
    const decision = unit.decisions.find((candidate) => candidate.submit.kind === "review" && candidate.submit.review === review && decisionAction(candidate) === req.action);
    if (!decision || decision.submit.kind !== "review") throw new Error(`oakridge ${gateId}: decision ${req.action} unavailable`);
    if (decision.fields.length > 1 || (decision.fields.length === 1 && decision.fields[0].key !== "feedback"))
      throw new Error(`oakridge ${gateId}: decision requires unsupported fields`);
    if (req.action === "request_revision" && decision.fields.length === 0 && req.feedback.trim())
      throw new Error(`oakridge ${gateId}: decision does not accept feedback`);
    const payload = decision.fields.length === 1 ? { feedback: req.feedback } : {};
    await decide(gate.runId, gate.unitId, review, decision.submit.decision, decision.submit.target_revision_id, payload, req.idempotency_key);
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
