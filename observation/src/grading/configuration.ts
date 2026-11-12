import { z } from "zod";
import { canonicalDigest, canonicalJson } from "canonical-json";
import type { EvaluatorDefinitionId, QuestionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { evaluatorIdentity, instructionDigest, type EvaluatorDefinition } from "./evaluator";
import { capabilityReferenceSchema, createCapabilityCollector, type CaptureConfiguration, type CapturePin, type QuestionScope } from "./evidence";
import type { EvidenceCapabilities, EvidenceCapabilityReference, EvidenceCollector } from "../ports/producer-profile";
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
  readonly item_fields: readonly string[];
}
export interface GradingRegistry {
  readonly selectors: readonly RegisteredSelector[];
  readonly capabilities: EvidenceCapabilities;
}

const pointerSchema = z.string().regex(/^\/(?:[^~]|~[01])*$/);
const targetSchema = z.strictObject({ artifact: z.string().min(1), selector: pointerSchema });
export type GradingTarget = z.infer<typeof targetSchema>;
const evidenceSchema = capabilityReferenceSchema;
const questionSchema = z.strictObject({
  text: z.string().nullable(), response: z.enum(["boolean", "choice", "ordinal", "numeric", "text", "structured"]),
  values: z.array(z.json()).nullable(), missing_evidence_policy: z.enum(["fail", "abstain"]),
  abstain_semantics: z.string(), unclear_semantics: z.string(), interpretation_caveats: z.string(),
});
export type GradingQuestion = z.infer<typeof questionSchema>;
const graderEntrySchema = z.strictObject({ runner: z.string().min(1).refine((runner) => runner !== "human"),
  model: z.string().min(1), instructions: z.json(), estimated_cost_per_call: z.number().finite().nonnegative() });
const definitionFields = { id: z.string().min(1), targets: z.array(targetSchema).min(1), evidence: z.array(evidenceSchema),
  question: questionSchema, evaluators: z.array(z.union([z.strictObject({ runner: z.literal("human") }), graderEntrySchema])) };
const definitionSchema = z.discriminatedUnion("scope", [
  z.strictObject({ ...definitionFields, scope: z.literal("per_item") }),
  z.strictObject({ ...definitionFields, scope: z.literal("per_task"), task_ids: pointerSchema }),
]);
interface GradingDefinitionFields {
  readonly id: string;
  readonly targets: readonly GradingTarget[];
  readonly evidence: readonly EvidenceCapabilityReference[];
  readonly question: GradingQuestion;
  readonly evaluators: readonly EvaluatorEntry[];
}
export type GradingDefinition = GradingDefinitionFields & QuestionScope;
/** observation/grading-definitions.json is the only question and evaluator selection. */
export type GradingDefinitions = readonly GradingDefinition[];
const configurationSchema = z.array(definitionSchema).min(1);

/** Human evaluation is implicit even when explicitly listed in the file. */
export const machineGraders = (definition: GradingDefinition): readonly GraderEntry[] =>
  definition.evaluators.filter((entry): entry is GraderEntry => "model" in entry);

/** Carried on every configured evaluator definition for the later budget consumer. */
export interface EvaluatorCostMetadata { readonly estimated_cost_per_call: number }

export type GraderConfigurationErrorKind = "invalid_definitions" | "duplicate_definition" | "unknown_capability" | "invalid_capability_params" | "unsupported_subject" | "unknown_selector"
  | "mixed_item_kinds" | "duplicate_target" | "invalid_task_ids" | "duplicate_grader" | "unknown_runner" | "invalid_instructions" | "invalid_definition";
export interface GraderConfigurationError {
  readonly operation: "grader_configuration";
  readonly kind: GraderConfigurationErrorKind;
  readonly entity_id: string;
  readonly detail: string;
}
const failure = (kind: GraderConfigurationErrorKind, entity_id: string, detail: string): Result<never, GraderConfigurationError> =>
  err({ operation: "grader_configuration", kind, entity_id, detail });

/** Preserve the definition id and task_ids field when strict union parsing refuses a scope. */
function shapeFailure(raw: unknown, issue: z.core.$ZodIssue | undefined): Result<never, GraderConfigurationError> {
  const index = issue?.path[0];
  const entry: unknown = Array.isArray(raw) && typeof index === "number" ? raw[index] : null;
  const identity = z.object({ id: z.string() }).safeParse(entry);
  const entity_id = identity.success ? identity.data.id : "grading-definitions.json";
  const scope = z.object({ scope: z.string(), task_ids: z.unknown().optional() }).safeParse(entry);
  const detail = issue ? `${issue.path.join(".") || "/"}: ${issue.message}` : "invalid definitions";
  if (scope.success) {
    const value = scope.data;
    if ((value.scope === "per_item" && Object.hasOwn(value, "task_ids"))
      || (value.scope === "per_task" && !pointerSchema.safeParse(value.task_ids).success))
      return failure("invalid_task_ids", entity_id, "task_ids: required JSON pointer for per_task; forbidden on per_item");
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


/** Capture needs only the scope fields of the configured definition. */
export function definitionScope(definition: GradingDefinition): QuestionScope {
  return definition.scope === "per_task" ? { scope: definition.scope, task_ids: definition.task_ids } : { scope: definition.scope };
}

/** Every machine runner the definitions select, once each; human needs no provider credentials. */
export const selectedRunners = (configuration: GradingDefinitions): readonly string[] =>
  [...new Set(configuration.flatMap((definition) => machineGraders(definition).map((grader) => grader.runner)))];

/** Evidence and evaluators do not change the meaning of the question. */
export function questionDefinition(definition: GradingDefinition, item_kind: string): Result<QuestionDefinition, GraderConfigurationError> {
  const version = canonicalDigest({ question: definition.question, ...definitionScope(definition), targets: definition.targets });
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
  readonly collector: EvidenceCollector;
}

interface PinnedQuestion { readonly pins: readonly CapturePin[]; readonly evaluators: readonly EvaluatorDefinition[]; readonly graders: readonly RegisteredGrader[] }

/** One question with the evaluators the definitions configure for it and the human evaluator every question keeps. */
interface QuestionSelection {
  readonly question: QuestionDefinition;
  readonly graders: readonly GraderEntry[];
  readonly human: EvaluatorDefinition;
  readonly scope: QuestionScope;
  readonly targets: readonly GradingTarget[];
  readonly evidence: readonly EvidenceCapabilityReference[];
}

function pinQuestion({ question, graders, human, scope, targets, evidence }: QuestionSelection): Result<PinnedQuestion, GraderConfigurationError> {
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
  return ok({ evaluators, pins: targets.map((target) => ({ ...key, ...scope, artifact_kind: target.artifact, item_selector: target.selector, item_kind: question.item_kind, evaluator_definition_ids: pinned, collection_plan: { ...key, evidence } })),
    graders: evaluators.map((evaluator) => ({ runner: evaluator.backend_kind, question: key,
      evaluator_definition_id: evaluator.evaluator_definition_id as EvaluatorDefinitionId })) });
}

/** Validate the capability contract for every target before any capture or provider call. */
interface EvidenceValidation {
  readonly definition: GradingDefinition;
  readonly registry: GradingRegistry;
  readonly selectors: readonly RegisteredSelector[];
}
function validateEvidence({ definition, registry, selectors }: EvidenceValidation)
  : Result<void, GraderConfigurationError> {
  for (const entry of definition.evidence) {
    const name = typeof entry === "string" ? entry : entry.capability;
    const capability = Object.hasOwn(registry.capabilities, name) ? registry.capabilities[name] : undefined;
    if (!capability) return failure("unknown_capability", definition.id, `evidence: ${name} is not registered`);
    const params = capability.params.safeParse(typeof entry === "string" ? {} : entry.params ?? {});
    if (!params.success) return failure("invalid_capability_params", definition.id, `evidence.${name}: ${params.error.message}`);
    for (const selector of selectors) {
      const missing = capability.subject.fields.find((field) => !selector.item_fields.includes(field));
      if (missing || (capability.subject.task_subject && definition.scope !== "per_task"))
        return failure("unsupported_subject", definition.id, `evidence.${name}: ${selector.artifact_kind} ${selector.item_selector} lacks ${missing ?? "per_task scope"}`);
    }
  }
  const scope = definitionScope(definition);
  if (scope.scope === "per_task" && selectors.some((selector) => !selector.item_fields.includes(scope.task_ids)))
    return failure("unsupported_subject", definition.id, "scope.task_ids: target does not declare this field");
  return ok(undefined);
}

/** Derive the questions and their pins. Every target shares one question key and evaluator set; evidence is resolved by capability. */
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
    const selectors: RegisteredSelector[] = [];
    const targets = new Set<string>();
    for (const target of definition.targets) {
      const key = JSON.stringify([target.artifact, target.selector]);
      if (targets.has(key)) return failure("duplicate_target", definition.id, `targets: ${target.artifact} ${target.selector} appears twice`);
      targets.add(key);
      const selector = registry.selectors.find((entry) => entry.artifact_kind === target.artifact && entry.item_selector === target.selector);
      if (!selector) return failure("unknown_selector", definition.id, `targets.selector: ${target.artifact} ${target.selector} is not registered`);
      if (selectors.some((entry) => entry.item_kind !== selector.item_kind))
        return failure("mixed_item_kinds", definition.id, "targets must all select one item kind");
      selectors.push(selector);
    }
    if (selectors.length === 0) return failure("invalid_definitions", definition.id, "targets must not be empty");
    const evidence = validateEvidence({ definition, registry, selectors });
    if (!evidence.ok) return evidence;
    if (definition.evaluators.filter((entry) => entry.runner === "human").length > 1)
      return failure("duplicate_grader", `${definition.id}:human`, "the same grader is configured twice");
    const question = questionDefinition(definition, selectors[0]!.item_kind);
    if (!question.ok) return question;
    const result = pinQuestion({ question: question.value, graders: machineGraders(definition), human: human.value, scope: definitionScope(definition), targets: definition.targets, evidence: definition.evidence });
    if (!result.ok) return result;
    questions.push(question.value);
    pinned.push(result.value);
  }
  const evaluators = [...new Map([...pinned.flatMap((entry) => entry.evaluators), human.value]
    .map((evaluator) => [evaluator.evaluator_definition_id, evaluator])).values()];
  return ok({ questions, evaluators, graders: pinned.flatMap((entry) => entry.graders),
    capture: { pins: pinned.flatMap((entry) => entry.pins) },
    collector: createCapabilityCollector(configuration.map((definition, index) => ({ ...questions[index]!, evidence: definition.evidence })), registry.capabilities) });
}
