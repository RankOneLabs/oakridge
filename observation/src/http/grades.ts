import type { Hono } from "hono";
import type { GradeObservationId, ItemOccurrenceId, QuestionId, ReviewerId } from "../domain/identity";
import { z } from "zod";
import { listGrades, submitHumanAnswer, type RecordedSubmission, type SubmissionRefusal } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { boundReviewer, credentialFor } from "./ingest-auth";
import { errorResponse, type ErrorBody, type ErrorStatus } from "./errors";
import { pagination } from "./items";

/**
 * What a reviewer sends to answer or correct one pinned question of one occurrence, which the route
 * names. The fields are the whole contract: strict parsing refuses any reviewer, evaluator or evidence
 * a client tries to choose, so identity can only come from the credential and evidence from the pin.
 */
export interface HumanSubmissionRequest {
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly submission_id: string;
  readonly answer: string;
  readonly rationale?: string | null;
  /** The reviewer's own current answer this one replaces; absent or null for a first answer. */
  readonly corrects_observation_id?: GradeObservationId | null;
}
/** Parsing is the boundary where request text becomes the identities it names. */
export const humanSubmissionRequestSchema = z.strictObject({
  question_id: z.string().min(1).transform((value) => value as QuestionId),
  question_version: z.string().min(1),
  submission_id: z.string().min(1).max(200),
  answer: z.string().min(1),
  rationale: z.string().nullable().optional(),
  corrects_observation_id: z.string().min(1).transform((value) => value as GradeObservationId).nullable().optional(),
});
/** The schema parses exactly the declared request, in both directions. */
type Exactly<Left, Right> = [Left] extends [Right] ? [Right] extends [Left] ? true : false : false;
const schemaMatchesRequest: Exactly<Readonly<z.infer<typeof humanSubmissionRequestSchema>>, HumanSubmissionRequest> = true;
void schemaMatchesRequest;

/** The only response on which a client may say an answer is saved. `duplicate` is the original result. */
export interface HumanSubmissionAcknowledgment extends Omit<RecordedSubmission, "recorded_at"> {
  readonly status: "recorded" | "duplicate";
  readonly recorded_at: string;
}
/** A refused submission: the general error body, with the refusal that explains it. */
export interface SubmissionRefusalBody extends ErrorBody { readonly error: ErrorBody["error"] & { readonly refusal: SubmissionRefusal } }
/** The reviewer a grade credential answers as. */
export interface ReviewerRead { readonly reviewer_id: ReviewerId }
const acknowledgment = (status: HumanSubmissionAcknowledgment["status"], submission: RecordedSubmission): HumanSubmissionAcknowledgment =>
  ({ status, ...submission, recorded_at: submission.recorded_at.toISOString() });

const REFUSAL_STATUS: Record<SubmissionRefusal["kind"], ErrorStatus> = { item_not_found: 404, question_not_pinned: 404, not_ready: 409,
  invalid_answer: 422, no_human_evaluator: 409, not_correctable: 409, stale_correction: 409, correction_required: 409 };
const refusalMessage = (refusal: SubmissionRefusal): string => {
  switch (refusal.kind) {
    case "item_not_found": return "item not found";
    case "question_not_pinned": return "this question is not pinned to this item";
    case "not_ready": return refusal.detail;
    case "invalid_answer": return refusal.detail;
    case "no_human_evaluator": return "this question has no pinned human evaluator";
    case "not_correctable": return refusal.detail;
    case "stale_correction": return "that answer has already been corrected; correct the current one";
    case "correction_required": return "this reviewer has already answered this question; a new answer must correct it";
  }
};

export function registerGradeRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/items/:id/grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    const grades = await listGrades(deps.db, credential, c.req.param("id"), page);
    return grades ? c.json(grades) : errorResponse(c, 404, "not_found", "item not found");
  });
  /** The reviewer a grade credential answers as, so a client can tell its own answers apart. */
  app.get("/v1/reviewer", (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    const reviewer: ReviewerRead = { reviewer_id: boundReviewer(credential) };
    return c.json(reviewer);
  });
  app.post("/v1/items/:id/answers", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential) return errorResponse(c, 403, "forbidden", "grade credential required");
    let input: unknown;
    try { input = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = humanSubmissionRequestSchema.safeParse(input);
    if (!parsed.success) return errorResponse(c, 400, "invalid_submission", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
    const { rationale, corrects_observation_id, question_id, ...request } = parsed.data;
    const result = await submitHumanAnswer(deps.db, credential, boundReviewer(credential), { ...request, question_id, occurrence_id: c.req.param("id") as ItemOccurrenceId,
      rationale: rationale?.trim() ? rationale : null, corrects_observation_id: corrects_observation_id ?? null });
    if (!result.ok) {
      const refused: SubmissionRefusalBody = { error: { code: result.error.kind, message: refusalMessage(result.error), refusal: result.error } };
      return c.json(refused, REFUSAL_STATUS[result.error.kind] as 404 | 409 | 422);
    }
    return c.json(acknowledgment(result.value.status, result.value.submission), result.value.status === "recorded" ? 201 : 200);
  });
}
