import type { JsonValue, Result } from "../domain/primitives";
import type { EvidenceSet } from "./evidence";
import type { EvaluatorDefinition } from "./evaluator";
import type { GradeAnswer } from "./observation";
import type { QuestionDefinition } from "./question";
import type { GradeRunner } from "../ports/grade-runner";
import { deterministicChecker } from "../runners/deterministic-checker";
import { coverageChecker } from "../runners/coverage-checker";
import { stubModelRunner } from "../runners/stub-model";
import { createJevDirectRunner } from "../runners/jev-direct";
import { createFastinoGlideRunner, FASTINO_SYSTEM_ONE_BASE_URL } from "../runners/fastino-glide";
import { createLlmJudgeRunner } from "../runners/llm-judge";

export type ProviderFailureCategory = "unconfigured_credential" | "invalid_request" | "invalid_unclear_designation" | "invalid_choice"
  | "invalid_response" | "rate_limit" | "timeout" | "transport" | "http_error";
export interface GradingError { readonly operation: string; readonly entity_id: string; readonly detail: string;
  readonly category?: ProviderFailureCategory;
  readonly outcome?: "lost_lease" | "in_progress";
  readonly external_execution_id?: string | null; readonly cost?: number | null }
export interface GradingContext {
  readonly question: QuestionDefinition;
  readonly evidence: EvidenceSet;
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

export interface RunnerRegistryEntry {
  readonly kind: "code" | "model";
  readonly network: boolean;
  readonly factory: (deadline_ms: number, env: NodeJS.ProcessEnv) => GradeRunner;
}

export const runnerRegistry = {
  deterministic: { kind: "code", network: false, factory: () => deterministicChecker },
  coverage: { kind: "code", network: false, factory: () => coverageChecker },
  stub_model: { kind: "model", network: false, factory: () => stubModelRunner },
  jev_direct: { kind: "model", network: true, factory: (deadline_ms, env) => createJevDirectRunner({
    base_url: env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1", api_key: env.TYPESAFE_API_KEY, deadline_ms }) },
  fastino_glide: { kind: "model", network: true, factory: (deadline_ms, env) => createFastinoGlideRunner({
    base_url: env.FASTINO_BASE_URL ?? FASTINO_SYSTEM_ONE_BASE_URL, api_key: env.FASTINO_API_KEY, deadline_ms }) },
  llm_judge: { kind: "model", network: true, factory: (deadline_ms, env) => createLlmJudgeRunner({
    api_key: env.OBSERVATION_LLM_JUDGE_API_KEY,
    base_url: env.OBSERVATION_LLM_JUDGE_BASE_URL ?? "https://api.openai.com/v1", deadline_ms }) },
} satisfies Record<string, RunnerRegistryEntry>;
export type RunnerName = keyof typeof runnerRegistry;
export const runnerNames = Object.keys(runnerRegistry) as [RunnerName, ...RunnerName[]];
export const networkRunnerNames = runnerNames.filter((name) => runnerRegistry[name].network);
export function runnerEntry(name: string): RunnerRegistryEntry | undefined {
  return runnerRegistry[name as RunnerName];
}
