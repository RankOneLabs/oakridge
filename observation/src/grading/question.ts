import { z } from "zod";
import { canonicalJson } from "canonical-json";
import type { GradeAnswer } from "./observation";
import type { JsonValue } from "../domain/primitives";
import type { QuestionId } from "../domain/identity";

export type ResponseKind = "boolean" | "choice" | "ordinal" | "numeric" | "text" | "structured";

/** The immutable key an occurrence pins and an execution measures. */
export interface QuestionKey {
  readonly question_id: QuestionId;
  readonly question_version: string;
}

/** Mirrors observation.question_definition: versioned wording, one item kind, its answers. */
export interface QuestionDefinition extends QuestionKey {
  readonly item_kind: string;
  readonly question_text: string | null;
  readonly response_kind: ResponseKind;
  readonly allowed_values: readonly JsonValue[] | null;
  readonly missing_evidence_policy: "fail" | "abstain";
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly interpretation_caveats: string;
}


const responseSchemas = {
  boolean: z.boolean(), choice: z.string(), ordinal: z.string(), numeric: z.number().finite(), text: z.string(), structured: z.json(),
};
/** Machine and human answers use the same output schema, derived solely from the pinned question. */
export function questionAnswerProblem(question: QuestionDefinition, answer: GradeAnswer): string | null {
  if (answer.kind !== question.response_kind) return `answer kind ${answer.kind} differs from question kind ${question.response_kind}`;
  if (answer.state !== "answered") return typeof answer.reason === "string" && answer.reason.length > 0 ? null : "an abstention needs a reason";
  if (!responseSchemas[question.response_kind].safeParse(answer.value).success)
    return `answer value does not match question response ${question.response_kind}`;
  if (question.allowed_values === null && question.response_kind !== "choice" && question.response_kind !== "ordinal") return null;
  const value = canonicalJson(answer.value);
  const is_allowed = value.ok && (question.allowed_values ?? []).some((allowed) => {
    const candidate = canonicalJson(allowed);
    return candidate.ok && candidate.value === value.value;
  });
  return is_allowed ? null : `answer ${String(answer.value)} is not an allowed value of ${question.question_id}@${question.question_version}`;
}
