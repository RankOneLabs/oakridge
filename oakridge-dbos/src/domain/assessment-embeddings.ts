import type { Citation, PathSegment, RevisionState } from "../core-client/core-types";
import { ok, traced, type Result, type TracedError } from "./primitives";

export type AssessmentFactError = TracedError;

function fieldAt(body: unknown, field: string): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, field)) return undefined;
  return (body as { readonly [key: string]: unknown })[field];
}

export function selectEmbeddedValues(body: unknown, paths: readonly (readonly PathSegment[])[]): unknown[] {
  return paths.flatMap(path => path.reduce<unknown[]>((values, segment) => {
    const next = segment.kind === "each" ? values.flatMap(value => Array.isArray(value) ? value : [])
      : values.map(value => fieldAt(value, segment.value));
    return next.filter(value => value !== undefined && value !== null);
  }, body == null ? [] : [body]));
}

export function resolveCitation(citation: Citation, revisions: readonly Pick<RevisionState, "id" | "body">[]): Result<null, AssessmentFactError> {
  const { revision_id, pointer } = citation;
  const refusal = () => traced("resolve_citation", revision_id, `citation ${revision_id}#${pointer} does not resolve`);
  const revision = revisions.find(value => value.id === revision_id);
  if (!revision) return refusal();
  if (pointer === "") return ok(null);
  if (!pointer.startsWith("/")) return refusal();
  let selected: unknown = revision.body;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(encoded)) return refusal();
    const field = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    selected = Array.isArray(selected)
      ? /^(?:0|[1-9][0-9]*)$/u.test(field) ? selected[Number(field)] : undefined
      : fieldAt(selected, field);
    if (selected === undefined) return refusal();
  }
  return ok(null);
}

import type { AssessmentEmbeddings, AssignmentUpdate, AssignmentVerification, AssignmentVerificationFact, FeedbackItem, FeedbackProposal } from "../core-client/core-types";
import type { AssessmentFacts, AssessmentWrites } from "../storage/assessment-facts";
import { selectCurrentRound, selectRoundProgress } from "../projections/assessment-status";
import { assessmentFactId } from "./dispatch-policy";

export interface AssessmentPublication {
  readonly run: string;
  readonly revision: RevisionState;
  readonly revisions: readonly RevisionState[];
  readonly embeddings: AssessmentEmbeddings;
  readonly facts: AssessmentFacts | null;
  readonly roundUpdate: AssignmentUpdate | null;
}

export function selectPublicationFacts(input: AssessmentPublication): Result<AssessmentWrites, AssessmentFactError> {
  const { run, revision, revisions, embeddings, facts, roundUpdate } = input;
  // The core has checked the structural schemas exported for these paths.
  const proposals = selectEmbeddedValues(revision.body, embeddings.proposals) as FeedbackProposal[];
  const values = selectEmbeddedValues(revision.body, embeddings.verifications) as AssignmentVerification[];
  const refusal = (detail: string) => traced("publish_assessment", revision.id, detail);
  const seen = new Set<string>();
  const items: FeedbackItem[] = [];
  for (const proposal of proposals) {
    if (proposal.key === "" || seen.has(proposal.key)) return refusal(`invalid or duplicate proposal key ${proposal.key}`);
    if (proposal.instruction === "") return refusal(`proposal ${proposal.key} requires an instruction`);
    seen.add(proposal.key);
    if (proposal.citation != null) {
      const citation = resolveCitation(proposal.citation, revisions);
      if (!citation.ok) return citation;
    }
    items.push({ id: assessmentFactId("fi_", [run, revision.id, proposal.key]), unit: revision.unit,
      assessment_artifact: revision.artifact, origin: { kind: "proposal", revision: revision.id, key: proposal.key },
      instruction: proposal.instruction, citation: proposal.citation });
  }
  const carried = facts?.items.filter(item => {
    if (facts.rejections.some(value => value.item === item.id && value.assignment == null)) return false;
    const assignments = facts.assignments.filter(value => value.item === item.id);
    return !assignments.length || assignments.some(assignment => {
      const round = selectCurrentRound(facts, assignment.id);
      if (!round) return true;
      const progress = selectRoundProgress(facts, round);
      return progress !== "assessor_verified" && progress !== "accepted_by_operator";
    });
  }) ?? [];
  const verifications: AssignmentVerificationFact[] = [];
  for (const verification of values) {
    const round = facts?.rounds.find(value => value.id === verification.round_id);
    const assignment = round && facts?.assignments.find(value => value.id === round.assignment);
    const update = roundUpdate?.round === round?.id ? roundUpdate : facts?.updates.find(value => value.round === round?.id);
    if (!facts || !round || !assignment || !update || !carried.some(item => item.id === assignment.item)
      || selectCurrentRound(facts, assignment.id)?.id !== round.id || facts.verifications.some(value => value.round === round.id)
      || verifications.some(value => value.round === round.id)) return refusal(`verification ${verification.round_id} names a superseded or un-updated round`);
    verifications.push({ id: assessmentFactId("av_", [round.id, revision.id]), round: round.id,
      assessment_revision: revision.id, update_revision: update.revision, outcome: verification.outcome });
  }
  if (roundUpdate && !verifications.some(value => value.round === roundUpdate.round)) {
    return refusal(`self-assessment requires verification for round ${roundUpdate.round}`);
  }
  return ok({ items, updates: roundUpdate ? [roundUpdate] : [], verifications, associations: [
    ...items.map(item => ({ assessment_revision: revision.id, item: item.id, association: "proposed" as const })),
    ...carried.map(item => ({ assessment_revision: revision.id, item: item.id, association: "carried" as const })),
  ] });
}

import type { AssessmentDecisionCommand, FeedbackDisposition } from "../core-client/core-types";

export function parseAssessmentDecision(raw: unknown): AssessmentDecisionCommand | null {
  const allowed = ["request_id", "decision", "target", "assessed_revision", "dispositions"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return null;
  const decision = fieldAt(raw, "decision");
  const target = fieldAt(raw, "target");
  const assessed_revision = fieldAt(raw, "assessed_revision");
  const dispositions = fieldAt(raw, "dispositions");
  if (typeof decision !== "string" || !decision || typeof target !== "string" || !target
    || typeof assessed_revision !== "string" || !assessed_revision || !Array.isArray(dispositions) || !dispositions.every(isDisposition)) return null;
  return { decision, target, assessed_revision, dispositions };
}

function isDisposition(value: unknown): value is FeedbackDisposition {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = fieldAt(value, "kind");
  const keys = kind === "reject" ? ["kind", "item", "reason"] : kind === "reject_follow_up" ? ["kind", "assignment", "reason"]
    : kind === "dispatch" ? ["kind", "item", "instruction", "recipients"] : [];
  if (keys.length === 0 || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    const member = fieldAt(value, key);
    return key === "recipients" ? Array.isArray(member) && member.every(worker => typeof worker === "string" && worker !== "")
      : typeof member === "string" && member !== "";
  });
}
