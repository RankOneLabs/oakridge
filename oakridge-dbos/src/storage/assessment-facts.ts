import type { AssessmentApproval, AssessmentFeedback, AssignmentRound, AssignmentUpdate, AssignmentVerificationFact,
  DispatchAuthorization, FeedbackAssignment, FeedbackItem, FeedbackRejection } from "../core-client/core-types";
import { jsonText, type Database, type DatabaseTransaction } from "./database";

type Reader = Database | DatabaseTransaction;

export interface AssessmentFacts {
  readonly unit: string;
  readonly artifact: string;
  readonly revision: string;
  readonly items: readonly FeedbackItem[];
  readonly rejections: readonly FeedbackRejection[];
  readonly assignments: readonly FeedbackAssignment[];
  readonly rounds: readonly AssignmentRound[];
  readonly updates: readonly AssignmentUpdate[];
  readonly verifications: readonly AssignmentVerificationFact[];
  readonly approval: AssessmentApproval | null;
  readonly authorizations: readonly DispatchAuthorization[];
}

export async function readAssessmentFacts(db: Reader, run: string, unit: string, artifact: string): Promise<AssessmentFacts | null> {
  const latest = await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run)
    .where("unit_id", "=", unit).where("artifact", "=", artifact).orderBy("seq", "desc").executeTakeFirst();
  if (!latest) return null;
  const revision = latest.id;
  const items = await db.selectFrom("authority.feedback_item as item").innerJoin("authority.assessment_feedback as association", "association.feedback_item_id", "item.id")
    .selectAll("item").where("item.run_id", "=", run).where("association.assessment_revision_id", "=", revision).orderBy("item.id").execute();
  const itemIds = items.map(row => row.id);
  const approvals = await db.selectFrom("authority.assessment_approval as approval")
    .innerJoin("authority.artifact_revision as revision", "revision.id", "approval.assessment_revision_id")
    .selectAll("approval").where("approval.run_id", "=", run).where("approval.unit_id", "=", unit).where("revision.artifact", "=", artifact).executeTakeFirst();
  const base = { unit, artifact, revision, approval: approvals ? { id: approvals.id, unit: approvals.unit_id,
    assessment_revision: approvals.assessment_revision_id, assessed_revision: approvals.assessed_revision_id,
    decision: approvals.decision_id, approved_by: approvals.approved_by } : null };
  if (itemIds.length === 0) return { ...base, items: [], rejections: [], assignments: [], rounds: [], updates: [], verifications: [], authorizations: [] };
  const [rejections, assignments, authorizations] = await Promise.all([
    db.selectFrom("authority.feedback_rejection").selectAll().where("run_id", "=", run).where("feedback_item_id", "in", itemIds).orderBy("created_at").execute(),
    db.selectFrom("authority.feedback_assignment").selectAll().where("run_id", "=", run).where("feedback_item_id", "in", itemIds).orderBy("recipient").orderBy("id").execute(),
    db.selectFrom("authority.dispatch_authorization").selectAll().where("run_id", "=", run).where("feedback_item_id", "in", itemIds).execute(),
  ]);
  const rounds = assignments.length === 0 ? [] : await db.selectFrom("authority.assignment_round").selectAll()
    .where("run_id", "=", run).where("assignment_id", "in", assignments.map(row => row.id)).orderBy("ordinal").execute();
  const roundIds = rounds.map(row => row.id);
  const [updates, verifications] = roundIds.length === 0 ? [[], []] : await Promise.all([
    db.selectFrom("authority.assignment_update").selectAll().where("run_id", "=", run).where("round_id", "in", roundIds).execute(),
    db.selectFrom("authority.assignment_verification").selectAll().where("run_id", "=", run).where("round_id", "in", roundIds).orderBy("created_at").execute(),
  ]);
  return { ...base,
    items: items.map(row => ({ id: row.id, unit: row.unit_id, assessment_artifact: row.assessment_artifact, instruction: row.instruction, citation: row.citation,
      origin: row.origin === "proposal" ? { kind: "proposal", revision: row.proposal_revision_id!, key: row.proposal_key! } : { kind: "operator", request_id: row.operator_request_id! } })),
    rejections: rejections.map(row => ({ id: row.id, item: row.feedback_item_id, assessment_revision: row.assessment_revision_id, assignment: row.assignment_id, reason: row.reason, decision: row.decision_id })),
    assignments: assignments.map(row => ({ id: row.id, item: row.feedback_item_id, target_unit: row.target_unit_id, target_artifact: row.target_artifact, recipient: row.recipient })),
    rounds: rounds.map(row => ({ id: row.id, assignment: row.assignment_id, ordinal: row.ordinal, authorization: row.authorization_id, instruction: row.instruction, decision: row.decision_id })),
    updates: updates.map(row => ({ round: row.round_id, revision: row.revision_id })),
    verifications: verifications.map(row => ({ id: row.id, round: row.round_id, assessment_revision: row.assessment_revision_id, update_revision: row.update_revision_id, outcome: row.outcome })),
    authorizations: authorizations.map(row => ({ id: row.id, item: row.feedback_item_id, target: { unit: row.target_unit_id, artifact: row.target_artifact,
      revision: row.target_revision_id }, instruction: row.instruction, recipients: row.recipients, operation: row.operation, policy: "operator_required", authorized_by: row.authorized_by })),
  };
}

export async function readRoundAssessment(db: Reader, run: string, round: string) {
  return await db.selectFrom("authority.assignment_round as round")
    .innerJoin("authority.feedback_assignment as assignment", "assignment.id", "round.assignment_id")
    .innerJoin("authority.feedback_item as item", "item.id", "assignment.feedback_item_id")
    .select(["item.unit_id", "item.assessment_artifact", "assignment.recipient", "item.id as item_id"])
    .where("round.run_id", "=", run).where("round.id", "=", round).executeTakeFirst();
}

export interface AssessmentWrites {
  readonly items?: readonly FeedbackItem[];
  readonly associations?: readonly AssessmentFeedback[];
  readonly updates?: readonly AssignmentUpdate[];
  readonly verifications?: readonly AssignmentVerificationFact[];
  readonly authorizations?: readonly DispatchAuthorization[];
  readonly rejections?: readonly FeedbackRejection[];
  readonly assignments?: readonly FeedbackAssignment[];
  readonly rounds?: readonly { readonly round: AssignmentRound; readonly action: string }[];
  readonly approval?: AssessmentApproval;
}

export async function writeAssessmentFacts(db: DatabaseTransaction, run: string, writes: AssessmentWrites): Promise<void> {
  const { items, associations, updates, verifications, authorizations, rejections, assignments, rounds, approval } = writes;
  if (items?.length) await db.insertInto("authority.feedback_item").values(items.map(item => ({ id: item.id, run_id: run, unit_id: item.unit,
    assessment_artifact: item.assessment_artifact, origin: item.origin.kind, instruction: item.instruction, citation: item.citation == null ? null : jsonText(item.citation),
    proposal_revision_id: item.origin.kind === "proposal" ? item.origin.revision : null, proposal_key: item.origin.kind === "proposal" ? item.origin.key : null,
    operator_request_id: item.origin.kind === "operator" ? item.origin.request_id : null }))).onConflict(conflict => conflict.doNothing()).execute();
  if (associations?.length) await db.insertInto("authority.assessment_feedback").values(associations.map(item => ({ run_id: run,
    assessment_revision_id: item.assessment_revision, feedback_item_id: item.item, association: item.association }))).onConflict(conflict => conflict.doNothing()).execute();
  if (authorizations?.length) await db.insertInto("authority.dispatch_authorization").values(authorizations.map(value => ({ id: value.id, run_id: run,
    feedback_item_id: value.item, operation: value.operation, target_unit_id: value.target.unit, target_artifact: value.target.artifact,
    target_revision_id: value.target.revision, instruction: value.instruction, recipients: value.recipients, policy: value.policy, authorized_by: value.authorized_by })))
    .onConflict(conflict => conflict.doNothing()).execute();
  if (assignments?.length) await db.insertInto("authority.feedback_assignment").values(assignments.map(value => ({ id: value.id,
    run_id: run, feedback_item_id: value.item, target_unit_id: value.target_unit, target_artifact: value.target_artifact, recipient: value.recipient })))
    .onConflict(conflict => conflict.doNothing()).execute();
  if (rounds?.length) await db.insertInto("authority.assignment_round").values(rounds.map(({ round, action }) => ({
    id: round.id, run_id: run, assignment_id: round.assignment, ordinal: round.ordinal, authorization_id: round.authorization,
    instruction: round.instruction, decision_id: round.decision, action_id: action }))).onConflict(conflict => conflict.columns(["assignment_id", "authorization_id"]).doNothing()).execute();
  if (updates?.length) await db.insertInto("authority.assignment_update").values(updates.map(value => ({ run_id: run, round_id: value.round,
    revision_id: value.revision }))).onConflict(conflict => conflict.doNothing()).execute();
  if (verifications?.length) await db.insertInto("authority.assignment_verification").values(verifications.map(value => ({ id: value.id, run_id: run,
    round_id: value.round, assessment_revision_id: value.assessment_revision, update_revision_id: value.update_revision, outcome: value.outcome })))
    .onConflict(conflict => conflict.doNothing()).execute();
  if (rejections?.length) await db.insertInto("authority.feedback_rejection").values(rejections.map(value => ({ id: value.id,
    run_id: run, feedback_item_id: value.item, assessment_revision_id: value.assessment_revision, assignment_id: value.assignment,
    reason: value.reason, decision_id: value.decision }))).onConflict(conflict => conflict.doNothing()).execute();
  if (approval) await db.insertInto("authority.assessment_approval").values({ id: approval.id, run_id: run, unit_id: approval.unit,
    assessment_revision_id: approval.assessment_revision, assessed_revision_id: approval.assessed_revision, decision_id: approval.decision,
    approved_by: approval.approved_by }).onConflict(conflict => conflict.doNothing()).execute();
}

export interface RoundDeliveryLocation { readonly run_id: string; readonly round: string }

export async function readRoundDelivery(db: Reader, location: RoundDeliveryLocation) {
  const path = await readRoundAssessment(db, location.run_id, location.round);
  if (!path) return null;
  const facts = await readAssessmentFacts(db, location.run_id, path.unit_id, path.assessment_artifact);
  const item = facts?.items.find(value => value.id === path.item_id);
  const round = facts?.rounds.find(value => value.id === location.round);
  return facts && item && round ? { item, round, facts } : null;
}
