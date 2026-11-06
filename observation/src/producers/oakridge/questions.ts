import type { QuestionId } from "../../domain/identity";
import type { QuestionDefinition } from "../../grading/question";
import { ASSESSMENT_FINDING_KIND, FINDING_KIND } from "./catalogue";

export const RELEVANCE_ID = "finding.relevance" as QuestionId;
export const CORRECTNESS_ID = "assessment_finding.correctness" as QuestionId;
export const EVIDENCE_SUPPORT_ID = "assessment_finding.evidence_support" as QuestionId;
const VERSION = "1";

/** The three supported questions. Risks, decisions, tasks, whole artifacts and verdicts have none. */
export const OAKRIDGE_QUESTIONS: readonly QuestionDefinition[] = [
  { question_id: RELEVANCE_ID, question_version: VERSION, item_kind: FINDING_KIND,
    question_text: "Is this finding relevant to the spec the run was launched with?",
    response_kind: "choice", allowed_values: ["relevant", "irrelevant", "unclear"], missing_evidence_policy: "abstain",
    abstain_semantics: "Abstain only when the evidence set is marked incomplete; low confidence alone is not abstention.",
    unclear_semantics: "Choose unclear when the finding and the full spec do not settle its relevance.",
    interpretation_caveats: "Judge this one finding against the full captured spec, not the whole analysis." },
  { question_id: CORRECTNESS_ID, question_version: VERSION, item_kind: ASSESSMENT_FINDING_KIND,
    question_text: "Is this assessment finding correct, given its cited evidence and the build it assesses?",
    response_kind: "choice", allowed_values: ["supported", "contradicted", "unclear"], missing_evidence_policy: "abstain",
    abstain_semantics: "Abstain only when the evidence set is marked incomplete; low confidence alone is not abstention.",
    unclear_semantics: "Choose unclear when the available evidence cannot establish whether the finding is correct.",
    interpretation_caveats: "Judge this one finding. Test and output citations are agent-reported; a file recorded as absent is evidence of absence. Linked task context is optional background." },
  { question_id: EVIDENCE_SUPPORT_ID, question_version: VERSION, item_kind: ASSESSMENT_FINDING_KIND,
    question_text: "Does this assessment finding's cited evidence support it?",
    response_kind: "choice", allowed_values: ["supports", "does_not_support", "unclear"], missing_evidence_policy: "abstain",
    abstain_semantics: "Abstain only when the evidence set is marked incomplete; low confidence alone is not abstention.",
    unclear_semantics: "Choose unclear when the citations cannot be judged either way, including when there are none.",
    interpretation_caveats: "Judge only the finding and its citations. Test and output citations are agent-reported." },
];
