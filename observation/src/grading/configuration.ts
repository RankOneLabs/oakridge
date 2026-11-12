import { z } from "zod";
import { canonicalDigest, canonicalJson } from "canonical-json";
import type { EvaluatorDefinitionId, QuestionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { evaluatorIdentity, instructionDigest, type EvaluatorDefinition } from "./evaluator";
import type { CaptureConfiguration, CapturePin } from "./evidence";
import type { QuestionDefinition, QuestionKey } from "./question";
import { runnerEntry } from "./runner";

/** A machine evaluator's runner-specific configuration. */
export interface GraderEntry {
  readonly runner: string;
  readonly model: string;
  readonly instructions: JsonValue;
  readonly estimated_cost_per_call: number;
}
export interface HumanEvaluatorEntry { readonly runner: "human" }
export type EvaluatorEntry = GraderEntry | HumanEvaluatorEntry;

/** Selectors mirror the producer's registered extractors, without question bindings. */
export interface RegisteredSelector {
  readonly artifact_kind: string;
  readonly item_selector: string;
  readonly item_kind: string;
}
/** One question the producer's evidence collector serves, with the only target and evidence it honours.
 * Capture matches by item kind and collection is fixed per question, so any other setting would load
 * and then be silently ignored; the loader refuses it instead. */
export interface SupportedQuestion {
  readonly question_id: QuestionId;
  readonly artifact: string;
  readonly selector: string;
  readonly scope: "per_item" | "per_task";
  readonly evidence: readonly string[];
}
export interface GradingRegistry {
  readonly selectors: readonly RegisteredSelector[];
  readonly evidence_sources: readonly string[];
  /** Questions served by the producer's evidence collector. */
  readonly questions: readonly SupportedQuestion[];
}

const targetFields = { artifact: z.string().min(1), selector: z.string().startsWith("/") };
const targetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ ...targetFields, scope: z.literal("per_item") }),
  z.strictObject({ ...targetFields, scope: z.literal("per_task"), task_ids: z.string().startsWith("/") }),
]);
export type GradingTarget = z.infer<typeof targetSchema>;
const questionSchema = z.strictObject({
  text: z.string().nullable(), response: z.enum(["boolean", "choice", "ordinal", "numeric", "text", "structured"]),
  values: z.array(z.json()).nullable(), missing_evidence_policy: z.enum(["fail", "abstain"]),
  abstain_semantics: z.string(), unclear_semantics: z.string(), interpretation_caveats: z.string(),
});
export type GradingQuestion = z.infer<typeof questionSchema>;
const graderEntrySchema = z.strictObject({ runner: z.string().min(1).refine((runner) => runner !== "human"),
  model: z.string().min(1), instructions: z.json(), estimated_cost_per_call: z.number().finite().nonnegative() });
const definitionSchema = z.strictObject({ id: z.string().min(1), target: targetSchema, evidence: z.array(z.string().min(1)),
  question: questionSchema, evaluators: z.array(z.union([z.strictObject({ runner: z.literal("human") }), graderEntrySchema])) });
export interface GradingDefinition {
  readonly id: string;
  readonly target: GradingTarget;
  readonly evidence: readonly string[];
  readonly question: GradingQuestion;
  readonly evaluators: readonly EvaluatorEntry[];
}
/** observation/grading-definitions.json is the only question and evaluator selection. */
export type GradingDefinitions = readonly GradingDefinition[];
const configurationSchema = z.array(definitionSchema).min(1);

/** Human evaluation is implicit even when explicitly listed in the file. */
export const machineGraders = (definition: GradingDefinition): readonly GraderEntry[] =>
  definition.evaluators.filter((entry): entry is GraderEntry => "model" in entry);

/** Carried on every configured evaluator definition for the later budget consumer. */
export interface EvaluatorCostMetadata { readonly estimated_cost_per_call: number }

export type GraderConfigurationErrorKind = "invalid_definitions" | "duplicate_definition" | "unknown_evidence" | "unknown_selector"
  | "unknown_question" | "unsupported_target" | "unsupported_evidence" | "invalid_task_ids" | "duplicate_grader" | "unknown_runner" | "invalid_instructions" | "invalid_definition";
export interface GraderConfigurationError {
  readonly operation: "grader_configuration";
  readonly kind: GraderConfigurationErrorKind;
  readonly entity_id: string;
  readonly detail: string;
}
const failure = (kind: GraderConfigurationErrorKind, entity_id: string, detail: string): Result<never, GraderConfigurationError> =>
  err({ operation: "grader_configuration", kind, entity_id, detail });

/** Preserve the definition id and task_ids field when strict union parsing refuses a target. */
function shapeFailure(raw: unknown, issue: z.core.$ZodIssue | undefined): Result<never, GraderConfigurationError> {
  const index = issue?.path[0];
  const entry: unknown = Array.isArray(raw) && typeof index === "number" ? raw[index] : null;
  const identity = z.object({ id: z.string() }).safeParse(entry);
  const entity_id = identity.success ? identity.data.id : "grading-definitions.json";
  const target = z.object({ target: z.object({ scope: z.string(), task_ids: z.unknown().optional() }) }).safeParse(entry);
  const detail = issue ? `${issue.path.join(".") || "/"}: ${issue.message}` : "invalid definitions";
  if (target.success && issue?.path[1] === "target") {
    const { scope, task_ids } = target.data.target;
    if ((scope === "per_item" && Object.hasOwn(target.data.target, "task_ids"))
      || (scope === "per_task" && (typeof task_ids !== "string" || !task_ids.startsWith("/"))))
      return failure("invalid_task_ids", entity_id, `target.task_ids: ${scope === "per_item" ? "forbidden on per_item" : "must be a JSON pointer beginning with /"}`);
  }
  return failure("invalid_definitions", entity_id, detail);
}

/** Strict parsing and semantic validation use only the producer registry supplied by the caller. */
export function parseGradingDefinitions(raw: unknown, registry: GradingRegistry): Result<GradingDefinitions, GraderConfigurationError> {
  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) return shapeFailure(raw, parsed.error.issues[0]);
  const registration = planRegistration(parsed.data, registry);
  return registration.ok ? ok(parsed.data) : registration;
}

/** Every machine runner the definitions select, once each; human needs no provider credentials. */
export const selectedRunners = (configuration: GradingDefinitions): readonly string[] =>
  [...new Set(configuration.flatMap((definition) => machineGraders(definition).map((grader) => grader.runner)))];

/** Evidence and evaluators do not change the meaning of the question. */
export function questionDefinition(definition: GradingDefinition, item_kind: string): Result<QuestionDefinition, GraderConfigurationError> {
  const version = canonicalDigest({ question: definition.question, target: definition.target });
  if (!version.ok) return failure("invalid_definition", definition.id, version.error.detail);
  const { text, response, values, ...semantics } = definition.question;
  return ok({ question_id: definition.id as QuestionId, question_version: version.value, item_kind,
    question_text: text, response_kind: response, allowed_values: values, ...semantics });
}

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
  if (!entry) return failure("unknown_runner", `${question.question_id}:${grader.runner}`, `question ${question.question_id} selects a runner that is not retained`);
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

/** One question with the evaluators the definitions configure for it and the human evaluator every question keeps. */
interface QuestionSelection {
  readonly question: QuestionDefinition;
  readonly graders: readonly GraderEntry[];
  readonly human: EvaluatorDefinition;
  readonly target: GradingTarget;
}

function pinQuestion({ question, graders, human, target }: QuestionSelection): Result<PinnedQuestion, GraderConfigurationError> {
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
  return ok({ evaluators, pin: { ...key, ...(target.scope === "per_task" ? { scope: target.scope, task_ids: target.task_ids } : { scope: target.scope }), item_kind: question.item_kind, evaluator_definition_ids: pinned },
    graders: evaluators.map((evaluator) => ({ runner: evaluator.backend_kind, question: key,
      evaluator_definition_id: evaluator.evaluator_definition_id as EvaluatorDefinitionId })) });
}

const isSameEvidence = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n");

/** A registered target or evidence list that this question's collector would not honour. */
function unsupportedSetting(definition: GradingDefinition, supported: SupportedQuestion): Result<never, GraderConfigurationError> | null {
  const { artifact, selector, scope } = definition.target;
  if (artifact !== supported.artifact || selector !== supported.selector || scope !== supported.scope)
    return failure("unsupported_target", definition.id,
      `target: the collector for this question reads only ${supported.artifact} ${supported.selector} ${supported.scope}`);
  if (!isSameEvidence(definition.evidence, supported.evidence))
    return failure("unsupported_evidence", definition.id, `evidence: the collector for this question gathers exactly ${supported.evidence.join(", ")}`);
  return null;
}

/** Derive the questions and their pins. Target and evidence must be exactly what the collector honours, because capture pins by item kind. */
export function planRegistration(configuration: GradingDefinitions, registry: GradingRegistry)
  : Result<GradingRegistration, GraderConfigurationError> {
  const human = humanEvaluator();
  if (!human.ok) return human;
  const ids = new Set<string>();
  const questions: QuestionDefinition[] = [];
  const pinned: PinnedQuestion[] = [];
  for (const definition of configuration) {
    if (ids.has(definition.id)) return failure("duplicate_definition", definition.id, "a definition is configured twice");
    ids.add(definition.id);
    const supported = registry.questions.find((question) => question.question_id === definition.id);
    if (!supported) return failure("unknown_question", definition.id, "id: no evidence collector is registered for this question");
    const selector = registry.selectors.find((entry) => entry.artifact_kind === definition.target.artifact
      && entry.item_selector === definition.target.selector);
    if (!selector) return failure("unknown_selector", definition.id, `target.selector: ${definition.target.artifact} ${definition.target.selector} is not registered`);
    const unknownEvidence = definition.evidence.find((name) => !registry.evidence_sources.includes(name));
    if (unknownEvidence) return failure("unknown_evidence", definition.id, `evidence: ${unknownEvidence} is not registered`);
    const unsupported = unsupportedSetting(definition, supported);
    if (unsupported) return unsupported;
    if (definition.evaluators.filter((entry) => entry.runner === "human").length > 1)
      return failure("duplicate_grader", `${definition.id}:human`, "the same grader is configured twice");
    const question = questionDefinition(definition, selector.item_kind);
    if (!question.ok) return question;
    const result = pinQuestion({ question: question.value, graders: machineGraders(definition), human: human.value, target: definition.target });
    if (!result.ok) return result;
    questions.push(question.value);
    pinned.push(result.value);
  }
  const evaluators = [...new Map([...pinned.flatMap((entry) => entry.evaluators), human.value]
    .map((evaluator) => [evaluator.evaluator_definition_id, evaluator])).values()];
  return ok({ questions, evaluators, graders: pinned.flatMap((entry) => entry.graders),
    capture: { pins: pinned.map((entry) => entry.pin) } });
}
