import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { err, ok, type Result } from "../domain/primitives";
import { withTenant, type Database, type TenantScope } from "./database";

export interface BlindAssignmentIdentity {
  readonly subject_occurrence_id: string;
  readonly evidence_set_id: string;
  readonly question_id: string;
  readonly question_version: string;
}
export interface BlindAssignmentError { readonly operation: "blind_assignment"; readonly entity_id: string; readonly detail: string }
export type BlindAssignmentState = "unsubmitted" | "claimed" | "expired" | "submitted";
export interface BlindAssignmentView extends BlindAssignmentIdentity {
  readonly assignment_id: string;
  readonly state: BlindAssignmentState;
  readonly claim_owner: string | null;
  readonly expires_at: Date | null;
  readonly submitted_observation_id: string | null;
  readonly question_text: string | null;
}
const failure = (entity_id: string, detail: string): Result<never, BlindAssignmentError> =>
  err({ operation: "blind_assignment", entity_id, detail });

export function assignmentState(row: { readonly submitted_observation_id: string | null;
  readonly claim_owner: string | null; readonly expires_at: Date | null }, now: Date): BlindAssignmentState {
  if (row.submitted_observation_id) return "submitted";
  if (!row.claim_owner) return "unsubmitted";
  return row.expires_at && row.expires_at <= now ? "expired" : "claimed";
}

export async function createBlindAssignment(db: Database, tenant: TenantScope, identity: BlindAssignmentIdentity)
  : Promise<Result<BlindAssignmentView, BlindAssignmentError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const eligible = await trx.selectFrom("observation.evaluation_eligibility").select(["tag", "payload"])
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("subject_occurrence_id", "=", identity.subject_occurrence_id)
        .where("question_id", "=", identity.question_id).where("question_version", "=", identity.question_version)
        .orderBy("recorded_at", "desc").executeTakeFirst();
      if (!eligible || eligible.tag !== "eligible" ||
        (eligible.payload as { evidence_set_id?: string }).evidence_set_id !== identity.evidence_set_id)
        return failure(identity.subject_occurrence_id, "eligible frozen subject and evidence required");
      const assignment_id = randomUUID();
      const row = await trx.insertInto("observation.blind_assignment").values({
        producer: tenant.producer, namespace: tenant.namespace, assignment_id, ...identity,
        claim_owner: null, claimed_at: null, expires_at: null, submitted_observation_id: null,
      }).onConflict((oc) => oc.columns(["producer", "namespace", "subject_occurrence_id", "question_id", "question_version"]).doNothing())
        .returningAll().executeTakeFirst();
      if (!row) return failure(identity.subject_occurrence_id, "assignment already exists");
      const question = await trx.selectFrom("observation.question_definition").select("question_text")
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("question_id", "=", identity.question_id).where("question_version", "=", identity.question_version)
        .executeTakeFirst();
      return ok({ ...identity, assignment_id, state: "unsubmitted", claim_owner: null, expires_at: null,
        submitted_observation_id: null, question_text: question?.question_text ?? null });
    });
  } catch (cause) { return failure(identity.subject_occurrence_id, String(cause)); }
}

export async function claimBlindAssignment(db: Database, tenant: TenantScope, assignment_id: string,
  reviewer_id: string, duration_seconds: number): Promise<Result<BlindAssignmentView, BlindAssignmentError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const row = await trx.updateTable("observation.blind_assignment")
        .set({ claim_owner: reviewer_id, claimed_at: sql`clock_timestamp()`,
          expires_at: sql`clock_timestamp() + ${duration_seconds} * interval '1 second'` })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("assignment_id", "=", assignment_id).where("claim_owner", "is", null)
        .returningAll().executeTakeFirst();
      if (!row) return failure(assignment_id, "assignment already claimed or missing");
      const question = await trx.selectFrom("observation.question_definition").select("question_text")
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("question_id", "=", row.question_id).where("question_version", "=", row.question_version)
        .executeTakeFirst();
      return ok({ assignment_id, subject_occurrence_id: row.subject_occurrence_id, evidence_set_id: row.evidence_set_id,
        question_id: row.question_id, question_version: row.question_version, state: assignmentState(row, new Date()),
        claim_owner: row.claim_owner, expires_at: row.expires_at,
        submitted_observation_id: row.submitted_observation_id, question_text: question?.question_text ?? null });
    });
  } catch (cause) { return failure(assignment_id, String(cause)); }
}

export async function readBlindAssignment(db: Database, tenant: TenantScope, assignment_id: string,
  reviewer_id: string): Promise<BlindAssignmentView | null> {
  return withTenant(db, tenant, async (trx) => {
    const row = await trx.selectFrom("observation.blind_assignment as a")
      .innerJoin("observation.question_definition as q", (join) => join.onRef("a.producer", "=", "q.producer")
        .onRef("a.namespace", "=", "q.namespace").onRef("a.question_id", "=", "q.question_id")
        .onRef("a.question_version", "=", "q.question_version"))
      .select(["a.assignment_id", "a.subject_occurrence_id", "a.evidence_set_id", "a.question_id", "a.question_version",
        "a.claim_owner", "a.expires_at", "a.submitted_observation_id", "a.claimed_at", "a.created_at", "q.question_text"])
      .where("a.producer", "=", tenant.producer).where("a.namespace", "=", tenant.namespace)
      .where("a.assignment_id", "=", assignment_id).executeTakeFirst();
    if (!row || (row.claim_owner && row.claim_owner !== reviewer_id)) return null;
    return { assignment_id, subject_occurrence_id: row.subject_occurrence_id, evidence_set_id: row.evidence_set_id,
      question_id: row.question_id, question_version: row.question_version,
      state: assignmentState(row, new Date()),
      claim_owner: row.claim_owner, expires_at: row.expires_at, submitted_observation_id: row.submitted_observation_id,
      question_text: row.question_text };
  });
}

/** Bounded queue of unclaimed assignments; frozen identifiers are safe before a claim. */
export async function listUnclaimedBlindAssignments(db: Database, tenant: TenantScope, limit: number)
  : Promise<readonly BlindAssignmentView[]> {
  return withTenant(db, tenant, async (trx) => {
    const rows = await trx.selectFrom("observation.blind_assignment as a")
      .innerJoin("observation.question_definition as q", (join) => join.onRef("a.producer", "=", "q.producer")
        .onRef("a.namespace", "=", "q.namespace").onRef("a.question_id", "=", "q.question_id")
        .onRef("a.question_version", "=", "q.question_version"))
      .select(["a.assignment_id", "a.subject_occurrence_id", "a.evidence_set_id", "a.question_id",
        "a.question_version", "q.question_text"])
      .where("a.producer", "=", tenant.producer).where("a.namespace", "=", tenant.namespace)
      .where("a.claim_owner", "is", null).orderBy("a.created_at").orderBy("a.assignment_id")
      .limit(limit).execute();
    return rows.map((row) => ({ ...row, state: "unsubmitted" as const, claim_owner: null,
      expires_at: null, submitted_observation_id: null }));
  });
}
