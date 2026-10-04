import { WORKER_STATES } from "../domain/dev-flow-v15";
import { V15_PAYLOAD_CONTRACTS, type BindingType } from "../domain/v15-action-inputs";
export { V15_PAYLOAD_CONTRACTS } from "../domain/v15-action-inputs";
import { z } from "zod";
import { err, ok, type Result } from "../domain/primitives";
import { V15_BINDING_SOURCES, V15_FACTS, V15_WORKER_KEYS, type WorkflowDefinition, type StageKey, type V15WorkerKey, type V15DecisionTree, type V15Change, type V15BindingSource } from "../domain/dev-flow-v15";

export const V15_STAGE_KEYS = ["repository_preparation", "spec_analysis", "planning", "brief_writing", "implementation", "final_integration"] as const satisfies readonly StageKey[];
const cohortStates = ["pending", "working", "awaiting_merge", "complete", "failed", "cancelled"] as const;
const workerStates = WORKER_STATES;
export type V15DefinitionErrorKind = "invalid_shape" | "unknown_field" | "action_ambiguous" | "action_missing" | "action_target_invalid" | "source_unavailable" | "source_type_mismatch" | "payload_coverage" | "worker_outside_cohort" | "action_point_undeclared" | "contradictory_changes" | "cyclic_tree" | "invalid_tree_reference" | "invalid_prerequisites";
export interface V15DefinitionError {
  readonly operation: "validate_v15_definition";
  readonly kind: V15DefinitionErrorKind;
  readonly path: string;
  readonly detail: string;
}
const failure = (kind: V15DefinitionErrorKind, path: string, detail: string): Result<never, V15DefinitionError> => err({ operation: "validate_v15_definition", kind, path, detail });
const binding = z.strictObject({ from: z.enum(V15_BINDING_SOURCES) });
const action = z.strictObject({ prompt: z.string().min(1).optional(), operation: z.literal("provision_repository_refs").optional(), inputs: z.record(z.string(), binding) });
const execution = z.strictObject({ settings: z.strictObject({ from: z.enum(["run.planner", "run.builder"]) }), pre_authorized_tools: z.array(z.string()), required_tools: z.array(z.string()), yolo: z.boolean() });
const output = (type: string) => z.strictObject({ type: z.literal(type), revision: z.enum(["update", "replace"]) });
const reviewActions = z.strictObject({ initial: action, revise: action, retry: action });
const changes = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set_cohort_state"), state: z.enum(cohortStates) }),
  z.strictObject({ kind: z.literal("set_worker_state"), worker: z.enum(V15_WORKER_KEYS), state: z.enum(workerStates) }),
  ...["accept_outputs", "clear_acceptance", "fence_execution"].map((kind) => z.strictObject({ kind: z.literal(kind), worker: z.enum(V15_WORKER_KEYS) })),
  ...["capture_accepted_build", "clear_accepted_build"].map((kind) => z.strictObject({ kind: z.literal(kind) })),
]);
// Each node is shallowly parsed. Children are visited iteratively, so deep or
// cyclic object inputs cannot overflow a recursive schema parser.
const node = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("match_cohort"), cases: z.partialRecord(z.enum(cohortStates), z.unknown()), otherwise: z.unknown() }),
  z.strictObject({ kind: z.literal("match_worker"), worker: z.enum(V15_WORKER_KEYS), cases: z.partialRecord(z.enum(workerStates), z.unknown()), otherwise: z.unknown() }),
  z.strictObject({ kind: z.literal("match_request"), cases: z.record(z.string(), z.unknown()), otherwise: z.unknown() }),
  z.strictObject({ kind: z.literal("if"), fact: z.enum(V15_FACTS), then: z.unknown(), else: z.unknown() }),
  z.strictObject({ kind: z.literal("apply"), changes: z.array(changes), actions: z.array(z.strictObject({ worker: z.enum(V15_WORKER_KEYS), action_point: z.string().min(1) })) }),
  z.strictObject({ kind: z.literal("wait"), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal("reject"), reason: z.string().min(1) }),
]);
const cohort = (workers: z.ZodType) => z.strictObject({ workers, decision_tree: z.unknown() });
const stage = (workers: z.ZodType) => z.strictObject({ prerequisites: z.array(z.enum(V15_STAGE_KEYS)), max_active_cohorts: z.number().int().positive().max(4), cohort: cohort(workers) });
const promptWorker = (outputs: z.ZodType, actionPoints: z.ZodType = reviewActions) => z.strictObject({ execution, outputs, action_points: actionPoints });
const definitionSchema = z.strictObject({
  key: z.literal("dev_flow_v15"), version: z.number().int().positive(),
  stages: z.strictObject({
    repository_preparation: stage(z.strictObject({ provision: z.strictObject({ outputs: z.strictObject({ repository_refs: output("dev.repository_refs") }), action_points: z.strictObject({ initial: action, retry: action }) }) })),
    spec_analysis: stage(z.strictObject({ spec: promptWorker(z.strictObject({ spec_analysis: output("dev.spec_analysis") })) })),
    planning: stage(z.strictObject({ plan: promptWorker(z.strictObject({ plan: output("dev.plan") })) })),
    brief_writing: stage(z.strictObject({ brief: promptWorker(z.strictObject({ briefs: z.strictObject({ type: z.literal("dev.build_brief"), revision: z.enum(["update", "replace"]), collection_key: z.literal("cohort_id") }) })) })),
    implementation: stage(z.strictObject({
      build: promptWorker(z.strictObject({ build_result: output("dev.build_result"), pr_summary: output("dev.pr_summary") }), z.strictObject({ initial: action, revise: action, retry: action, replace_pr: action })),
      assessment: promptWorker(z.strictObject({ assessment: output("dev.assessment") }), z.strictObject({ initial: action, discuss: action, retry: action })),
    })),
    final_integration: stage(z.strictObject({ final_integration: promptWorker(z.strictObject({ pr_summary: output("dev.pr_summary") }), z.strictObject({ initial: action, retry: action })) })),
  }),
});

const inputTypes: Readonly<Record<StageKey, BindingType>> = { repository_preparation: "provision_inputs", spec_analysis: "spec_inputs", planning: "plan_inputs", brief_writing: "brief_inputs", implementation: "prepared_repository", final_integration: "final_inputs" };
const sourceType = (source: V15BindingSource, stageKey: StageKey, worker: V15WorkerKey): BindingType => {
  if (source === "inputs") return inputTypes[stageKey];
  if (source === "inputs.repository") return stageKey === "repository_preparation" ? "run_repository" : stageKey === "final_integration" ? "repository_refs" : "prepared_repository";
  if (source === "request.feedback") return worker === "brief" ? "brief_feedback" : worker === "build" ? "build_feedback" : worker === "assessment" ? "assessment_feedback" : "artifact_feedback";
  if (source.endsWith(".execution")) return "interruption";
  if (source.endsWith(".work")) return `${source.split(".")[0]}_work` as BindingType;
  if (source === "inputs.base_branch" || source === "inputs.brief_notes") return "text";
  if (source === "inputs.repositories") return "repositories";
  if (source === "inputs.completed_cohorts") return "completed_cohorts";
  if (source === "build.outputs") return "build_outputs";
  if (source === "accepted_build" || source === "assessment.work.input.accepted_build") return "accepted_build";
  if (source === "observations.pr") return "pr_observation";
  if (source.startsWith("brief.")) return "brief_collection";
  if (source.includes(".interrupted.")) return "nullable_artifact_ref";
  return "artifact_ref";
};

interface DeclaredAction { readonly prompt?: string; readonly operation?: string; readonly inputs: Readonly<Record<string, { readonly from: V15BindingSource }>> }
interface DeclaredWorker { readonly execution?: { readonly settings: { readonly from: string } }; readonly action_points: Readonly<Record<string, DeclaredAction>> }
interface DeclaredStage { readonly prerequisites: readonly StageKey[]; readonly cohort: { readonly workers: Readonly<Record<string, DeclaredWorker>>; readonly decision_tree: unknown } }
const checkActions = (stageKey: StageKey, workers: DeclaredStage["cohort"]["workers"]): Result<void, V15DefinitionError> => {
  for (const [workerName, worker] of Object.entries(workers)) {
    const workerKey = workerName as V15WorkerKey;
    if (workerKey !== "provision" && worker.execution?.settings.from !== (workerKey === "build" || workerKey === "final_integration" ? "run.builder" : "run.planner")) return failure("invalid_shape", `${stageKey}.${workerKey}.execution`, "Worker settings source does not match its execution contract");
    const contracts = V15_PAYLOAD_CONTRACTS.find((entry) => entry.worker === workerKey)!;
    for (const [point, declaration] of Object.entries(worker.action_points)) {
      const path = `${stageKey}.${workerKey}.${point}`;
      if (declaration.prompt !== undefined && declaration.operation !== undefined) return failure("action_ambiguous", path, "An action cannot declare both prompt and operation");
      if (declaration.prompt === undefined && declaration.operation === undefined) return failure("action_missing", path, "An action requires a prompt or operation");
      if ((workerKey === "provision") !== (declaration.operation !== undefined)) return failure("action_target_invalid", path, "Only the provision worker may declare the repository provisioning operation");
      const contract = contracts.actions[point]!;
      if (Object.keys(declaration.inputs).sort().join("|") !== Object.keys(contract.fields).sort().join("|")) return failure("payload_coverage", path, "Bindings must cover exactly the named input payload fields");
      for (const [field, value] of Object.entries(declaration.inputs)) {
        if (!contract.available.includes(value.from)) return failure("source_unavailable", `${path}.inputs.${field}`, `Source '${value.from}' is unavailable for this action`);
        if (sourceType(value.from, stageKey, workerKey) !== contract.fields[field]) return failure("source_type_mismatch", `${path}.inputs.${field}`, `Source '${value.from}' cannot supply ${contract.fields[field]}`);
      }
    }
  }
  return ok(undefined);
};

const requestKinds = ["none", "accept_analysis", "revise_analysis", "retry_analysis", "accept_plan", "revise_plan", "retry_plan", "accept_briefs", "revise_briefs", "retry_briefs", "retry_provision", "retry_final_integration", "confirm_merged", "closed_without_merge", "accept_build", "request_build_changes", "retry_build", "accept_assessment", "discuss_assessment", "request_implementation_changes", "retry_assessment", "replace_pr", "abandon", "cancel"];
const writesConflict = (changes: readonly V15Change[]): boolean => {
  const writes = new Map<string, string>();
  for (const change of changes) {
    const field = change.kind === "set_cohort_state" ? "cohort.state" : change.kind === "set_worker_state" ? `${change.worker}.state`
      : change.kind === "accept_outputs" || change.kind === "clear_acceptance" ? `${change.worker}.acceptance`
        : change.kind === "capture_accepted_build" || change.kind === "clear_accepted_build" ? "accepted_build" : null;
    if (!field) continue;
    const value = "state" in change ? change.state : change.kind;
    if (writes.has(field) && writes.get(field) !== value) return true;
    writes.set(field, value);
  }
  return false;
};
interface TreeContext {
  readonly cohort_state: string | null;
  readonly worker_states: Readonly<Partial<Record<V15WorkerKey, string>>>;
  readonly request_kind: string | null;
  readonly facts: readonly string[];
}
interface TreeVisit { readonly input: unknown; readonly path: string; readonly leaving: boolean; readonly context: TreeContext }
const launchSourcesAvailable = (launch: { readonly worker: V15WorkerKey; readonly action_point: string }, context: TreeContext, changes: readonly V15Change[]): boolean => {
  const state = context.worker_states[launch.worker];
  if (launch.action_point === "retry") return state === "interrupted";
  if (launch.action_point === "discuss") return state === "awaiting_review" && context.request_kind === "discuss_assessment";
  if (launch.action_point === "revise") {
    const feedbackRequests = launch.worker === "build" ? ["request_build_changes", "request_implementation_changes"]
      : launch.worker === "spec" ? ["revise_analysis"] : launch.worker === "plan" ? ["revise_plan"] : ["revise_briefs"];
    return feedbackRequests.includes(context.request_kind ?? "") && (state === "awaiting_review"
      || launch.worker === "build" && state === "accepted" && context.worker_states.assessment === "awaiting_review");
  }
  if (launch.action_point === "replace_pr") return context.facts.includes("pr_closed_unmerged")
    && (state === "accepted" || state === "awaiting_review" || context.cohort_state === "awaiting_merge");
  if (launch.worker === "assessment") return state !== "interrupted"
    && context.worker_states.build === "awaiting_review"
    && changes.some((change) => change.kind === "capture_accepted_build");
  return context.cohort_state === "pending";
};
const checkTree = (stageKey: StageKey, stageValue: DeclaredStage): Result<void, V15DefinitionError> => {
  const active = new Set<object>();
  const stack: TreeVisit[] = [{ input: stageValue.cohort.decision_tree, path: `${stageKey}.decision_tree`, leaving: false,
    context: { cohort_state: null, worker_states: {}, request_kind: null, facts: [] } }];
  while (stack.length > 0) {
    const visit = stack.pop()!;
    if (typeof visit.input !== "object" || visit.input === null) return failure("invalid_shape", visit.path, "Expected a decision node");
    if (visit.leaving) { active.delete(visit.input); continue; }
    if (active.has(visit.input)) return failure("cyclic_tree", visit.path, "Decision trees must be finite and acyclic");
    const parsed = node.safeParse(visit.input);
    if (!parsed.success) return failure(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys") ? "unknown_field" : "invalid_shape", visit.path, z.prettifyError(parsed.error));
    const tree = parsed.data;
    if (tree.kind === "match_worker" && !Object.hasOwn(stageValue.cohort.workers, tree.worker)) return failure("worker_outside_cohort", visit.path, `Worker '${tree.worker}' is not owned by this cohort`);
    if (tree.kind === "if") {
      const owner = tree.fact.split("_")[0];
      const worker = owner === "final" ? "final_integration" : owner;
      if (V15_WORKER_KEYS.includes(worker as V15WorkerKey) && !Object.hasOwn(stageValue.cohort.workers, worker)) return failure("invalid_tree_reference", visit.path, `Fact '${tree.fact}' belongs to another cohort`);
      if (tree.fact.startsWith("pr_") && stageKey !== "implementation") return failure("invalid_tree_reference", visit.path, "Implementation PR fact outside the implementation cohort");
    }
    if (tree.kind === "match_request" && Object.keys(tree.cases).some((kind) => !requestKinds.includes(kind))) return failure("invalid_tree_reference", visit.path, "Unknown operator request kind");
    if (tree.kind === "apply") {
      for (const change of tree.changes) {
        if ("worker" in change && !Object.hasOwn(stageValue.cohort.workers, change.worker)) return failure("worker_outside_cohort", visit.path, "Change references a worker outside this cohort");
        if ((change.kind === "capture_accepted_build" || change.kind === "clear_accepted_build") && stageKey !== "implementation") return failure("invalid_tree_reference", visit.path, "Accepted build changes belong to implementation");
      }
      if (writesConflict(tree.changes as readonly V15Change[])) return failure("contradictory_changes", visit.path, "A leaf cannot write conflicting values to the same field");
      const launches = new Set<string>();
      for (const launch of tree.actions) {
        const worker = stageValue.cohort.workers[launch.worker];
        if (!worker) return failure("worker_outside_cohort", visit.path, `Worker '${launch.worker}' is not owned by this cohort`);
        if (!Object.hasOwn(worker.action_points, launch.action_point)) return failure("action_point_undeclared", visit.path, `Action point '${launch.worker}.${launch.action_point}' is undeclared`);
        if (!launchSourcesAvailable(launch, visit.context, tree.changes as readonly V15Change[])) return failure("source_unavailable", visit.path, `The branch does not establish inputs for '${launch.worker}.${launch.action_point}'`);
        if (launches.has(launch.worker)) return failure("contradictory_changes", visit.path, "A leaf cannot launch the same worker twice");
        launches.add(launch.worker);
      }
    }
    active.add(visit.input);
    stack.push({ ...visit, leaving: true });
    if (tree.kind === "if") {
      // z.unknown accepts undefined: explicitly require both branches.
      if (!Object.hasOwn(visit.input, "then") || !Object.hasOwn(visit.input, "else")) return failure("invalid_shape", visit.path, "An if node requires both branches");
      stack.push({ input: tree.then, path: `${visit.path}.then`, leaving: false, context: { ...visit.context, facts: [...visit.context.facts, tree.fact] } },
        { input: tree.else, path: `${visit.path}.else`, leaving: false, context: visit.context });
    } else if (tree.kind === "match_cohort" || tree.kind === "match_worker" || tree.kind === "match_request") {
      if (!Object.hasOwn(visit.input, "otherwise")) return failure("invalid_shape", visit.path, "A match node requires an explicit fallback");
      const otherwiseContext = tree.kind === "match_worker" ? { ...visit.context, worker_states: { ...visit.context.worker_states, [tree.worker]: undefined } }
        : tree.kind === "match_cohort" ? { ...visit.context, cohort_state: null } : { ...visit.context, request_kind: null };
      stack.push({ input: tree.otherwise, path: `${visit.path}.otherwise`, leaving: false, context: otherwiseContext });
      for (const [key, child] of Object.entries(tree.cases)) {
        const context = tree.kind === "match_worker" ? { ...visit.context, worker_states: { ...visit.context.worker_states, [tree.worker]: key } }
          : tree.kind === "match_cohort" ? { ...visit.context, cohort_state: key } : { ...visit.context, request_kind: key };
        stack.push({ input: child, path: `${visit.path}.cases.${key}`, leaving: false, context });
      }
    }
  }
  return ok(undefined);
};

export const parseV15WorkflowDefinition = (input: unknown): Result<WorkflowDefinition, V15DefinitionError> => {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys") ? "unknown_field" : "invalid_shape", "definition", z.prettifyError(parsed.error));
  const stages = parsed.data.stages as unknown as Readonly<Record<StageKey, DeclaredStage>>;
  const completed = new Set<StageKey>();
  while (completed.size < V15_STAGE_KEYS.length) {
    const next = V15_STAGE_KEYS.filter((key) => !completed.has(key) && stages[key].prerequisites.every((dependency) => completed.has(dependency)));
    if (next.length === 0) return failure("invalid_prerequisites", "stages", "Stage prerequisites must be acyclic");
    next.forEach((key) => completed.add(key));
  }
  for (const key of V15_STAGE_KEYS) {
    const current = stages[key];
    if (new Set(current.prerequisites).size !== current.prerequisites.length) return failure("invalid_prerequisites", key, "Duplicate prerequisite");
    const checkedActions = checkActions(key, current.cohort.workers);
    if (!checkedActions.ok) return checkedActions;
    const checkedTree = checkTree(key, current);
    if (!checkedTree.ok) return checkedTree;
  }
  // Every discriminant, owned worker, action point and child was checked above.
  return ok(parsed.data as unknown as WorkflowDefinition);
};

export interface V15DecisionTreeValidation {
  readonly tree: V15DecisionTree;
  readonly stage_key: StageKey;
  readonly definition: WorkflowDefinition;
}
export const validateV15DecisionTree = ({ tree, stage_key, definition }: V15DecisionTreeValidation): Result<void, V15DefinitionError> => checkTree(stage_key, { ...definition.stages[stage_key], cohort: { workers: definition.stages[stage_key].cohort.workers as unknown as DeclaredStage["cohort"]["workers"], decision_tree: tree } });
