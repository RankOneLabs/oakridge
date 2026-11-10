import { z } from "zod";
import { canonicalDigest, canonicalJson } from "canonical-json";
import type { EvaluatorDefinitionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { evaluatorIdentity, instructionDigest, type EvaluatorDefinition } from "./evaluator";
import type { CaptureConfiguration, CapturePin } from "./evidence";
import type { QuestionDefinition, QuestionKey } from "./question";
import { runnerEntry } from "./runner";

/** One configured grader for one question. Mirrors an entry of `observation/graders.json`. */
export interface GraderEntry {
  readonly runner: string;
  readonly model: string;
  /** Runner-specific instructions: a System One recipe, or a judge rubric. */
  readonly instructions: JsonValue;
  /** What one provider call is expected to cost, for the later per-run budget. */
  readonly estimated_cost_per_call: number;
}
export interface QuestionGraders { readonly question_id: string; readonly graders: readonly GraderEntry[] }
/** `observation/graders.json`: the only place a grader is selected. */
export interface GraderConfiguration { readonly questions: readonly QuestionGraders[] }

/** Carried on every configured evaluator definition for the later budget consumer. */
export interface EvaluatorCostMetadata { readonly estimated_cost_per_call: number }

export type GraderConfigurationErrorKind = "invalid_graders" | "duplicate_question" | "unknown_question"
  | "duplicate_grader" | "unknown_runner" | "invalid_instructions" | "invalid_definition";
export interface GraderConfigurationError {
  readonly operation: "grader_configuration";
  readonly kind: GraderConfigurationErrorKind;
  readonly entity_id: string;
  readonly detail: string;
}
const failure = (kind: GraderConfigurationErrorKind, entity_id: string, detail: string): Result<never, GraderConfigurationError> =>
  err({ operation: "grader_configuration", kind, entity_id, detail });

const graderEntrySchema = z.strictObject({ runner: z.string().min(1), model: z.string().min(1), instructions: z.json(),
  estimated_cost_per_call: z.number().finite().nonnegative() });
const configurationSchema = z.strictObject({ questions: z.array(z.strictObject({ question_id: z.string().min(1),
  graders: z.array(graderEntrySchema).min(1) })).min(1) });

/** Parses graders.json. Unknown fields are refused so a misspelt setting cannot be silently ignored. */
export function parseGraderConfiguration(raw: unknown): Result<GraderConfiguration, GraderConfigurationError> {
  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure("invalid_graders", "graders.json", issue ? `${issue.path.join(".") || "/"}: ${issue.message}` : "invalid");
  }
  return ok(parsed.data as GraderConfiguration);
}

/** Every runner the configuration selects, once each. */
export const selectedRunners = (configuration: GraderConfiguration): readonly string[] =>
  [...new Set(configuration.questions.flatMap((question) => question.graders.map((grader) => grader.runner)))];

function identified(fields: Omit<EvaluatorDefinition, "evaluator_definition_id">): Result<EvaluatorDefinition, GraderConfigurationError> {
  const identity = evaluatorIdentity({ ...fields, evaluator_definition_id: "" });
  return identity.ok ? ok({ ...fields, evaluator_definition_id: identity.value })
    : failure("invalid_definition", fields.backend_kind, identity.error.detail);
}

const HUMAN_INSTRUCTIONS = "Answer the pinned question from its frozen evidence set. The reviewer is the identity bound to the grade credential that submits the answer.";
const HUMAN_CONFIG = canonicalDigest(["human-evaluator/v1"]);
/** The one human evaluator. It names no reviewer: each answer takes its reviewer from its credential. */
export function humanEvaluator(): Result<EvaluatorDefinition, GraderConfigurationError> {
  if (!HUMAN_CONFIG.ok) return failure("invalid_definition", "human", HUMAN_CONFIG.error.detail);
  return identified({ kind: "human", backend_kind: "human", provider: "reviewer", model: null,
    instruction_text: HUMAN_INSTRUCTIONS, prompt_digest: instructionDigest(HUMAN_INSTRUCTIONS), config_digest: HUMAN_CONFIG.value,
    runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null });
}

/** One configured grader becomes one immutable definition. Its identity covers the question,
 * runner, model, instructions and estimated cost, so any edit is a new definition. */
export function configuredEvaluator(question: QuestionDefinition, grader: GraderEntry): Result<EvaluatorDefinition, GraderConfigurationError> {
  const entry = runnerEntry(grader.runner);
  if (!entry) return failure("unknown_runner", grader.runner, `question ${question.question_id} selects a runner that is not retained`);
  const problem = entry.instruction_problem(grader.instructions, question);
  if (problem) return failure("invalid_instructions", `${question.question_id}:${grader.runner}`, problem);
  const instruction_text = canonicalJson(grader.instructions);
  if (!instruction_text.ok) return failure("invalid_instructions", `${question.question_id}:${grader.runner}`, instruction_text.error.detail);
  const config = canonicalDigest(["grader-configuration/v1", question.question_id, question.question_version, grader.runner,
    grader.model, instruction_text.value, grader.estimated_cost_per_call]);
  if (!config.ok) return failure("invalid_definition", `${question.question_id}:${grader.runner}`, config.error.detail);
  const cost_metadata: EvaluatorCostMetadata = { estimated_cost_per_call: grader.estimated_cost_per_call };
  return identified({ kind: entry.kind, backend_kind: grader.runner, provider: entry.provider, model: grader.model,
    instruction_text: instruction_text.value, prompt_digest: instructionDigest(instruction_text.value), config_digest: config.value,
    runtime_revision: entry.runtime_revision, cost_metadata: { ...cost_metadata }, seed: null, attempt_controls: null });
}

/** A registered machine grader, as health and the later lifecycle read it. */
export interface RegisteredGrader {
  readonly runner: string;
  readonly question: QuestionKey;
  readonly evaluator_definition_id: EvaluatorDefinitionId;
}
/** Everything startup registers, and the pins a capture writes until the next restart. */
export interface GradingRegistration {
  readonly questions: readonly QuestionDefinition[];
  readonly evaluators: readonly EvaluatorDefinition[];
  readonly graders: readonly RegisteredGrader[];
  readonly capture: CaptureConfiguration;
}

interface PinnedQuestion { readonly pin: CapturePin; readonly evaluators: readonly EvaluatorDefinition[]; readonly graders: readonly RegisteredGrader[] }

/** One question with the graders graders.json configures for it and the human evaluator every question keeps. */
interface QuestionSelection {
  readonly question: QuestionDefinition;
  readonly graders: readonly GraderEntry[];
  readonly human: EvaluatorDefinition;
}

function pinQuestion({ question, graders, human }: QuestionSelection): Result<PinnedQuestion, GraderConfigurationError> {
  const evaluators: EvaluatorDefinition[] = [];
  for (const grader of graders) {
    const evaluator = configuredEvaluator(question, grader);
    if (!evaluator.ok) return evaluator;
    if (evaluators.some((known) => known.evaluator_definition_id === evaluator.value.evaluator_definition_id))
      return failure("duplicate_grader", `${question.question_id}:${grader.runner}`, "the same grader is configured twice");
    evaluators.push(evaluator.value);
  }
  const key: QuestionKey = { question_id: question.question_id, question_version: question.question_version };
  const pinned = [...evaluators, human].map((evaluator) => evaluator.evaluator_definition_id as EvaluatorDefinitionId);
  return ok({ evaluators, pin: { ...key, item_kind: question.item_kind, evaluator_definition_ids: pinned },
    graders: evaluators.map((evaluator) => ({ runner: evaluator.backend_kind, question: key,
      evaluator_definition_id: evaluator.evaluator_definition_id as EvaluatorDefinitionId })) });
}

/**
 * Maps graders.json onto the producer's questions. Every question is pinned with its configured
 * graders and the human evaluator; a question graders.json does not mention is pinned to the human
 * evaluator alone. A configured question the producer does not ask is refused.
 */
export function planRegistration(configuration: GraderConfiguration, questions: readonly QuestionDefinition[])
  : Result<GradingRegistration, GraderConfigurationError> {
  const configured = new Map<string, QuestionGraders>();
  for (const entry of configuration.questions) {
    if (configured.has(entry.question_id)) return failure("duplicate_question", entry.question_id, "a question is configured twice");
    if (!questions.some((question) => question.question_id === entry.question_id))
      return failure("unknown_question", entry.question_id, "the producer asks no question with this id");
    configured.set(entry.question_id, entry);
  }
  const human = humanEvaluator();
  if (!human.ok) return human;
  const pinned: PinnedQuestion[] = [];
  for (const question of questions) {
    const result = pinQuestion({ question, graders: configured.get(question.question_id)?.graders ?? [], human: human.value });
    if (!result.ok) return result;
    pinned.push(result.value);
  }
  const evaluators = [...new Map([...pinned.flatMap((entry) => entry.evaluators), human.value]
    .map((evaluator) => [evaluator.evaluator_definition_id, evaluator])).values()];
  return ok({ questions, evaluators, graders: pinned.flatMap((entry) => entry.graders),
    capture: { pins: pinned.map((entry) => entry.pin) } });
}
