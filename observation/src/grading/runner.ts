import type { JsonValue, Result } from "../domain/primitives";
import type { ReadyEvidence } from "./evidence";
import type { EvaluatorDefinition } from "./evaluator";
import type { GradeAnswer } from "./observation";
import type { QuestionDefinition } from "./question";
import type { GradeRunner } from "../ports/grade-runner";
import { createJevDirectRunner, systemOneInstructionProblem } from "../runners/jev-direct";
import { createFastinoGlideRunner, FASTINO_SYSTEM_ONE_BASE_URL } from "../runners/fastino-glide";
import { createLlmJudgeRunner, judgeInstructionProblem } from "../runners/llm-judge";

export type ProviderFailureCategory = "unconfigured_credential" | "invalid_request" | "invalid_unclear_designation" | "invalid_choice"
  | "invalid_response" | "rate_limit" | "timeout" | "transport" | "http_error";
export interface GradingError { readonly operation: string; readonly entity_id: string; readonly detail: string;
  readonly category?: ProviderFailureCategory;
  readonly outcome?: "lost_lease" | "in_progress";
  readonly external_execution_id?: string | null; readonly cost?: number | null }
export interface GradingContext {
  readonly question: QuestionDefinition;
  readonly evidence: ReadyEvidence;
  readonly evaluator: EvaluatorDefinition;
}
export interface EvaluationOutcome {
  readonly answer: GradeAnswer;
  readonly probabilities?: Readonly<Record<string, number>> | null;
  readonly confidence?: number | null;
  readonly model_usage?: JsonValue | null;
  readonly cost?: number | null;
  readonly external_execution_id?: string | null;
  readonly provider_link?: string | null;
  readonly reproducibility_metadata?: JsonValue | null;
  readonly comments?: string | null;
  readonly rationale?: string | null;
  readonly quality_flags?: readonly string[];
}
export type RunnerResult = Result<EvaluationOutcome, GradingError>;

/** The environment names a runner reads: what must be set, and what it may also use. */
export interface RunnerCredentials { readonly required: readonly string[]; readonly optional: readonly string[] }
/** One retained runner implementation. Which runner grades which question is chosen only by
 * published grading configuration; an entry here is a capability, never a selection. */
export interface RunnerRegistryEntry {
  readonly kind: "code" | "model";
  /** Who serves the requests, recorded on every evaluator definition this runner backs. */
  readonly provider: string;
  /** The implementation revision, part of each definition's identity. */
  readonly runtime_revision: string;
  readonly credentials: RunnerCredentials;
  /** Why configured instructions cannot ask a question through this runner, or null. */
  readonly instruction_problem: (instructions: JsonValue, question: QuestionDefinition) => string | null;
  readonly factory: (deadline_ms: number, env: NodeJS.ProcessEnv) => GradeRunner;
}

export const runnerRegistry = {
  jev_direct: { kind: "model", provider: "typesafe", runtime_revision: "1", instruction_problem: systemOneInstructionProblem,
    credentials: { required: ["TYPESAFE_API_KEY"], optional: ["TYPESAFE_BASE_URL"] }, factory: (deadline_ms, env) => createJevDirectRunner({
    base_url: env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1", api_key: env.TYPESAFE_API_KEY, deadline_ms }) },
  fastino_glide: { kind: "model", provider: "fastino", runtime_revision: "1", instruction_problem: systemOneInstructionProblem,
    credentials: { required: ["FASTINO_API_KEY"], optional: ["FASTINO_BASE_URL"] }, factory: (deadline_ms, env) => createFastinoGlideRunner({
    base_url: env.FASTINO_BASE_URL ?? FASTINO_SYSTEM_ONE_BASE_URL, api_key: env.FASTINO_API_KEY, deadline_ms }) },
  llm_judge: { kind: "model", provider: "openai_compatible", runtime_revision: "1", instruction_problem: judgeInstructionProblem,
    credentials: { required: ["OBSERVATION_LLM_JUDGE_API_KEY"], optional: ["OBSERVATION_LLM_JUDGE_BASE_URL"] }, factory: (deadline_ms, env) => createLlmJudgeRunner({
    api_key: env.OBSERVATION_LLM_JUDGE_API_KEY,
    base_url: env.OBSERVATION_LLM_JUDGE_BASE_URL ?? "https://api.openai.com/v1", deadline_ms }) },
} satisfies Record<string, RunnerRegistryEntry>;
export type RunnerName = keyof typeof runnerRegistry;
export function runnerEntry(name: string): RunnerRegistryEntry | undefined {
  return Object.hasOwn(runnerRegistry, name) ? runnerRegistry[name as RunnerName] : undefined;
}
