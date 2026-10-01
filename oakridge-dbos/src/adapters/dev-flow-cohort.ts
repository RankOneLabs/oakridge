/**
 * The dev-flow stage type's cohort driver: how a delegated-session stage opens
 * its cohorts and how one cohort advances.
 *
 * This is the composition side of `dev-flow-build.ts`, which owns the pure
 * machine. Everything here is a *translation*: committed v15 rows into the
 * `BuildCohortEvent` vocabulary the machine already understands, and the
 * machine's answer into the cohort transition core commits. It holds no state
 * of its own — the cohort's `stage_data` is the state, so a replay after
 * recovery reaches the same decision from the same rows.
 */
import {
  applyBuildCohortEvent,
  committedSessionLaunch,
  createBuildCohortMachine,
  initialBuildCohortState,
  selectBuildGateEvent,
  type BuildCohortEvent,
  type BuildCohortMachine,
  type BuildCohortState,
  type BuildSessionRole,
} from "./dev-flow-build";
import type { StageInputSet } from "../decision/commands";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import { selectArtifactGateDisposition, selectBuiltInGateDisposition } from "../domain/gates";
import type { AttemptId, JsonValue, RunTransitionId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { hasOwn, readOwn } from "../domain/records";
import type { CohortMachineState, OpenCohort } from "../domain/run-record";
import type { PromptBundleEntry } from "../domain/workflow";
import { attemptWorkflowId } from "../decision/ids";
import { cohortIdFor, resolveCohortRoster } from "./cohort-roster";
import type { DevFlowPullRequestRepository, RunRecordRepository } from "../storage/repositories";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { readJsonPointer } from "../domain/json-pointer";
import { parseRepositoryRefs } from "../domain/repository-refs";
import { prepareDevFlowBuildCohort } from "../runtime/cohort-pull-request";
import { resolveAttemptExecution } from "../runtime/resolve-work-order";
import type { CohortMachineDriver, CohortStepContext, CohortStepDecision } from "../workflows/run-record-topology";

/** `oakridge.cohort.stage_data` for a dev-flow cohort. */
interface DevFlowCohortStageData {
  /** The fan-out item's own key, as the operator projections read it. */
  readonly unit_id: string;
  /** The item the stage fanned out over. Projections read `artifact.repository_key`. */
  readonly artifact: JsonValue;
  /** The build machine's own state, nested so it cannot collide with the item. */
  readonly build_state: BuildCohortState;
  readonly consumed_gate_wait_ids: readonly string[];
}

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contractOf = (value: JsonValue): CompiledStageContract => {
  if (!isObject(value)) throw new Error("stage contract is not an object");
  return value as unknown as CompiledStageContract;
};

const definitionConfigOf = (contract: CompiledStageContract): DelegatedSessionDefinitionConfig =>
  contract.executor.definition_config as DelegatedSessionDefinitionConfig;

/** Which declared outputs the build role must fill before its gate can open. */
const requiredBuildSet = (contract: CompiledStageContract): readonly string[] => {
  const declared = definitionConfigOf(contract).required_build_set;
  if (declared && declared.length > 0) return declared;
  // A stage that declares none owes every gated output it has. Falling back to
  // the empty set would make `isBuildReviewReady` vacuously true and open the
  // gate on nothing.
  const gated = contract.outputs.filter((output) => output.release.kind !== "immediate").map((output) => output.name);
  return gated.length > 0 ? gated : contract.outputs.map((output) => output.name);
};

const stageDataOf = (state: CohortMachineState, contract: CompiledStageContract): DevFlowCohortStageData => {
  const stored = state.stage_data;
  if (isObject(stored) && hasOwn(stored, "build_state") && isObject(stored.build_state)) {
    return { unit_id: typeof stored.unit_id === "string" ? stored.unit_id : state.cohort_key,
      artifact: readOwn(stored, "artifact") ?? null,
      build_state: stored.build_state as unknown as BuildCohortState,
      consumed_gate_wait_ids: Array.isArray(stored.consumed_gate_wait_ids)
        ? stored.consumed_gate_wait_ids.filter((value): value is string => typeof value === "string") : [] };
  }
  return {
    unit_id: isObject(stored) && typeof stored.unit_id === "string" ? stored.unit_id : state.cohort_key,
    artifact: isObject(stored) ? readOwn(stored, "artifact") ?? null : null,
    build_state: initialBuildCohortState(requiredBuildSet(contract)),
    consumed_gate_wait_ids: [],
  };
};

const encodeStageData = (data: DevFlowCohortStageData): JsonValue => ({
  unit_id: data.unit_id, artifact: data.artifact,
  build_state: data.build_state as unknown as JsonValue,
  consumed_gate_wait_ids: [...data.consumed_gate_wait_ids],
});

/** One revision this cohort has published, whether or not a gate has accepted it. */
interface PublishedRevision {
  readonly output_name: string;
  readonly artifact_id: string;
  readonly artifact_type: string;
  readonly body: JsonValue | null;
}

/**
 * Everything this cohort has published into a declared output.
 *
 * Open gate waits *and* acceptances, because publication is the fact the machine
 * advances on. Reading acceptances alone meant `build_artifact_recorded` only
 * arrived once a gate had already released the artifact — so `build_review`, the
 * phase that means "the operator is holding the gate", was entered after the gate
 * had answered, and the answer itself landed at `builder_active` where the driver
 * treats it as already acted on.
 */
const publishedRevisions = (state: CohortMachineState, contract: CompiledStageContract): readonly PublishedRevision[] => {
  const typeOf = (output_name: string): string =>
    contract.outputs.find((output) => output.name === output_name)?.artifact_type ?? "";
  const parked = state.open_waits.flatMap((wait): readonly PublishedRevision[] =>
    wait.kind === "gate" && wait.output_name !== null && wait.artifact_id !== null
      ? [{ output_name: wait.output_name, artifact_id: wait.artifact_id,
        artifact_type: typeOf(wait.output_name), body: wait.artifact_body ?? null }]
      : []);
  const accepted = state.accepted_outputs.map((artifact): PublishedRevision => ({
    output_name: artifact.output_name, artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type, body: artifact.body }));
  return [...parked, ...accepted];
};

/**
 * The identity of the work a set of published outputs describes.
 *
 * The machine's `revision` is what ties a build's outputs to each other and to
 * the pull request verified for them: `observeBuildArtifact` drops a verification
 * whose revision no longer matches, which is how a build that published again
 * stops counting an older PR as verified. It therefore has to be *one* value
 * shared by every output of the same publication. Keyed per artifact, the build
 * stage's two required outputs reset each other's `accepted_build_set` on every
 * step and the machine re-recorded the pair forever.
 *
 * Derived from the published artifact ids: a republished output is a new artifact,
 * so the identity changes exactly when the work does.
 */
const publishedBuildRevision = (published: readonly PublishedRevision[]): string =>
  published.map((revision) => revision.artifact_id).sort().join("+");

/**
 * The next fact this cohort owes the machine, read from committed rows only.
 *
 * Order matters and is deliberate: a decided gate is the operator's answer and
 * outranks anything an agent has since published, and a published artifact
 * outranks the stage's own start. Exactly one event per step keeps each
 * transition attributable to one fact.
 */
const nextEvent = (
  state: CohortMachineState,
  build: BuildCohortState,
  contract: CompiledStageContract,
): BuildCohortEvent | null => {
  const published = publishedRevisions(state, contract);
  const assessment = published.find((revision) => revision.artifact_type === "dev.assessment"
    && (state.latest_attempt === null || state.latest_assessment_published_at === undefined
      || (state.latest_assessment_published_at !== null
        && state.latest_assessment_published_at >= state.latest_attempt.created_at)));
  if (assessment && build.assessment_artifact_id !== assessment.artifact_id) {
    return { kind: "assessment_artifact_recorded", artifact_id: assessment.artifact_id };
  }

  // The build role's own outputs, under one revision. An output already recorded
  // under a *different* revision is owed again: that is how a republished build
  // replaces the set the previous one was reviewed as.
  const buildOutputs = published.filter((revision) => build.required_build_set.includes(revision.output_name));
  const revision = publishedBuildRevision(buildOutputs);
  const owed = build.required_build_set.find((name) =>
    !(build.accepted_revision === revision && build.accepted_build_set.includes(name)));
  const owedRevision = owed === undefined ? undefined : buildOutputs.find((candidate) => candidate.output_name === owed);
  if (owed !== undefined && owedRevision) {
    return { kind: "build_artifact_recorded", revision, output_name: owed };
  }

  if (build.phase === "pending") return { kind: "stage_started" };
  if (state.latest_attempt !== null && state.latest_attempt.ended_at !== null
    && state.latest_unfinished_attempt_id === null) {
    if (build.phase === "builder_active" && !build.required_build_set.every((name) =>
      buildOutputs.some((output) => output.output_name === name))) return { kind: "builder_attempt_lost" };
    if (build.phase === "assessor_active" && !assessment) return { kind: "assessor_attempt_lost" };
  }
  return null;
};

interface SelectedGateDecision {
  readonly event: BuildCohortEvent;
  readonly consumed_wait_ids: readonly string[];
}

const selectGateDecision = (
  state: CohortMachineState, stageData: DevFlowCohortStageData, contract: CompiledStageContract,
): SelectedGateDecision | null => {
  const unconsumed = state.decided_gates.filter((gate) =>
    !stageData.consumed_gate_wait_ids.includes(gate.wait_id));
  if (unconsumed.length === 0) return null;
  const build = stageData.build_state;
  const published = publishedRevisions(state, contract);
  const currentBuildIds = new Set(build.accepted_revision?.split("+") ?? []);
  const publishedBuildIds = new Set(published.filter((item) =>
    build.required_build_set.includes(item.output_name)).map((item) => item.artifact_id));
  const isCurrent = (gate: typeof unconsumed[number]): boolean =>
    build.phase === "build_review" ? gate.artifact_id !== null && currentBuildIds.has(gate.artifact_id)
      : build.phase === "assessment_review" && gate.artifact_id === build.assessment_artifact_id;
  const isAwaitingArtifactRecord = (gate: typeof unconsumed[number]): boolean =>
    gate.artifact_id !== null && (build.phase === "builder_active"
      && build.required_build_set.includes(gate.output_name ?? "") && publishedBuildIds.has(gate.artifact_id)
      || build.phase === "assessor_active" && gate.output_name === "assessment"
        && published.some((item) => item.artifact_id === gate.artifact_id));
  const stale = unconsumed.find((gate) => !isCurrent(gate) && !isAwaitingArtifactRecord(gate));
  if (stale) return { event: { kind: "stale_gate_recorded" }, consumed_wait_ids: [stale.wait_id] };
  if (unconsumed.some(isAwaitingArtifactRecord)) return null;
  const disposition = (gate: typeof unconsumed[number]) => selectArtifactGateDisposition(
    contract.outputs.find((output) => output.name === gate.output_name)?.artifact_type ?? "",
    selectBuiltInGateDisposition(gate.action));
  if (build.phase === "build_review") {
    const current = unconsumed.filter(isCurrent);
    if (current.some((gate) => disposition(gate) === "revise")) {
      return { event: { kind: "build_review_revision_requested" },
        consumed_wait_ids: current.map((gate) => gate.wait_id) };
    }
    if (build.required_build_set.every((name) => current.some((gate) =>
      gate.output_name === name && disposition(gate) === "release"))) {
      return { event: { kind: "build_review_approved" },
        consumed_wait_ids: current.map((gate) => gate.wait_id) };
    }
    return null;
  }
  const assessment = unconsumed[0];
  if (!assessment || build.phase !== "assessment_review") return null;
  const selected = selectBuildGateEvent("assessment_review", disposition(assessment));
  return selected.ok ? { event: selected.value, consumed_wait_ids: [assessment.wait_id] } : null;
};

export interface DevFlowCohortDriverDependencies {
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  readonly pull_requests: DevFlowPullRequestRepository;
  readonly git: GitCommandRunner;
  readonly verify_build_pull_request: (input: { readonly cohort_id: CohortMachineState["cohort_id"];
    readonly stage_instance_id: StageInstanceId; readonly cohort_key: string; readonly candidate_url: string }) =>
    Promise<import("../domain/primitives").Result<{
      readonly pull_request_url: string; readonly head_sha: string; readonly binding: string },
      import("../runtime/cohort-pull-request").CohortPullRequestVerificationError |
      import("../runtime/cohort-pull-request").PullRequestBindingError>>;
  /**
   * The prompt cells this run was pinned to, by `bundle_pin.prompt_bundle_hash`.
   * Loaded per run rather than read from the definition, because the pin is what
   * makes a mid-run bundle change unable to alter a session's prompt.
   */
  load_prompt_bundle(run_id: WorkflowRunId): Promise<readonly PromptBundleEntry[]>;
  /** The stage type this driver is registered for — the delegated-session executor. */
  readonly stage_type: string;
}

/** The roster, with each cohort opened at the build machine's initial state. */
const openDevFlowCohorts = (
  stage_instance_id: StageInstanceId,
  contract: CompiledStageContract,
  run_context: JsonValue,
  inputs: StageInputSet,
): readonly OpenCohort[] =>
  resolveCohortRoster(contract, run_context, inputs).map((entry) => ({
    depends_on: entry.depends_on,
    id: cohortIdFor(stage_instance_id, entry.cohort_key),
    cohort_key: entry.cohort_key,
    stage_data: encodeStageData({ unit_id: entry.cohort_key, artifact: entry.item,
      build_state: initialBuildCohortState(requiredBuildSet(contract)), consumed_gate_wait_ids: [] }),
  }));

export const createDevFlowCohortDriver = (dependencies: DevFlowCohortDriverDependencies): CohortMachineDriver => ({
  stage_type: dependencies.stage_type,

  open_cohorts: async (input) => openDevFlowCohorts(input.stage_instance_id,
    contractOf(input.stage_contract), input.run_context, input.inputs),

  async step(context: CohortStepContext): Promise<CohortStepDecision | null> {
    const contract = contractOf(context.stage_contract);
    const stageData = stageDataOf(context.state, contract);
    const gateDecision = selectGateDecision(context.state, stageData, contract);
    if (gateDecision) return applyOne(context, gateDecision.event, dependencies, gateDecision.consumed_wait_ids);
    const event = nextEvent(context.state, stageData.build_state, contract);
    if (event !== null) return applyOne(context, event, dependencies);
    const build = stageData.build_state;
    const revision = build.accepted_revision;
    if (build.phase !== "builder_active" || revision === null
      || !build.required_build_set.every((name) => build.accepted_build_set.includes(name))
      || build.verified_pull_request?.revision === revision) return null;
    const summary = publishedRevisions(context.state, contract).find((item) => item.output_name === "pr_summary");
    const summaryBody = summary?.body ?? null;
    const candidateUrl = isObject(summaryBody) && typeof summaryBody.pr_url === "string" ? summaryBody.pr_url : "";
    const verified = await dependencies.verify_build_pull_request({ cohort_id: context.state.cohort_id,
      stage_instance_id: context.state.stage_instance_id, cohort_key: context.state.cohort_key,
      candidate_url: candidateUrl });
    if (verified.ok) return applyOne(context, { kind: "pull_request_verified", revision,
      pull_request_url: verified.value.pull_request_url, head_sha: verified.value.head_sha }, dependencies);
    if (verified.error.kind === "unreadable_pull_request" || verified.error.kind === "git_read_failed") return null;
    return applyOne(context, { kind: verified.error.kind === "replacement_required"
      || verified.error.kind === "replacement_conflict" ? "replacement_pull_request_required" : "pull_request_mismatch",
      pull_request_url: candidateUrl }, dependencies);
  },

  apply_event(context: CohortStepContext, event: JsonValue): Promise<CohortStepDecision | null> {
    const decoded = decodeBuildCohortEvent(event);
    return decoded === null ? Promise.resolve(null) : applyOne(context, decoded, dependencies);
  },
});

/**
 * An externally-supplied fact, narrowed to the machine's vocabulary.
 *
 * Parsed rather than cast: these arrive from the pull-request reconciler and the
 * final-stage routes, and an unrecognised name must be ignored rather than
 * committed as a transition whose effect nothing can read.
 */
const decodeBuildCohortEvent = (value: JsonValue): BuildCohortEvent | null => {
  if (!isObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "pull_request_verified" && typeof value.revision === "string"
    && typeof value.pull_request_url === "string" && typeof value.head_sha === "string") {
    return { kind: "pull_request_verified", revision: value.revision,
      pull_request_url: value.pull_request_url, head_sha: value.head_sha };
  }
  if (value.kind === "pull_request_merged" && typeof value.pull_request_url === "string"
    && typeof value.head_sha === "string") {
    return { kind: "pull_request_merged", pull_request_url: value.pull_request_url, head_sha: value.head_sha };
  }
  if ((value.kind === "pull_request_mismatch" || value.kind === "replacement_pull_request_required")
    && typeof value.pull_request_url === "string") {
    return { kind: value.kind, pull_request_url: value.pull_request_url };
  }
  if (value.kind === "builder_attempt_lost" || value.kind === "assessor_attempt_lost" || value.kind === "stage_started") {
    return { kind: value.kind };
  }
  if (value.kind === "operator_retry_requested") return { kind: "operator_retry_requested" };
  if (value.kind === "assessment_outcome_observed" && typeof value.outcome === "string") {
    return { kind: "assessment_outcome_observed", outcome: value.outcome };
  }
  return null;
};

/**
 * Applies exactly one event and shapes the transition it implies.
 *
 * `recorded_only` still commits: the machine's state changed, and the cohort's
 * own durable version is what makes that change observable to the next reader —
 * a fact recorded without a phase move is still a fact.
 */
const applyOne = async (
  context: CohortStepContext,
  event: BuildCohortEvent,
  dependencies: DevFlowCohortDriverDependencies,
  consumed_wait_ids: readonly string[] = [],
): Promise<CohortStepDecision> => {
  const contract = contractOf(context.stage_contract);
  const stageData = stageDataOf(context.state, contract);
  const machine = buildMachineFor(contract, await dependencies.load_prompt_bundle(context.state.run_id));
  const applied = applyBuildCohortEvent(machine, stageData.build_state, event);
  const nextStageData: DevFlowCohortStageData = { ...stageData, build_state: applied.state,
    consumed_gate_wait_ids: [...stageData.consumed_gate_wait_ids, ...consumed_wait_ids] };
  const launch = applied.launch;
  return {
    event: {
      change: applied.projection,
      stage_data: encodeStageData(nextStageData),
      reopen_output_names: applied.effect.reopen_output_names,
      effect: applied.effect as unknown as CohortStepDecision["event"]["effect"],
      launch_reason: launchReasonFor(event),
      actor: "core",
    },
    launch: launch === null ? null : {
      attempt_number: context.state.attempt_count + 1,
      adapter_type: contract.executor.executor_type,
      resolve_request: async (attempt_id: AttemptId, launch_transition_id: RunTransitionId) => {
        let cohort = await dependencies.pull_requests.find_cohort_for_unit(
          context.state.stage_instance_id, context.state.cohort_key as UnitId);
        if (launch.session_role === "build" && cohort === null) {
          const repositoryValue = readJsonPointer(nextStageData.artifact, "/artifact/repository_key");
          const repositoryKey = typeof repositoryValue === "string" ? repositoryValue : null;
          if (!repositoryKey) throw new Error("build brief has no repository_key");
          const refsInput = context.inputs.repository_refs;
          const envelopes = refsInput === undefined ? [] : Array.isArray(refsInput) ? refsInput : [refsInput];
          const refsBody = envelopes.find((envelope) => isObject(envelope.body)
            && envelope.body.repository_key === repositoryKey)?.body;
          if (refsBody === undefined) throw new Error(`repository refs for '${repositoryKey}' are missing`);
          const repository = parseRepositoryRefs(refsBody);
          if (!repository.ok) throw new Error(repository.error.detail);
          const prepared = await prepareDevFlowBuildCohort({ pull_requests: dependencies.pull_requests, git: dependencies.git }, {
            cohort_id: context.state.cohort_id, stage_instance_id: context.state.stage_instance_id,
            cohort_key: context.state.cohort_key, repository: repository.value,
            prepared_at: new Date().toISOString(),
          });
          if (!prepared.ok) throw new Error(`${prepared.error.kind}: ${prepared.error.detail}`);
          cohort = prepared.value.cohort;
        }
        const resolved = await resolveAttemptExecution({
          run_id: context.state.run_id, stage: contract, stage_instance_id: context.state.stage_instance_id,
          unit: { unit_id: context.state.cohort_key as UnitId, parameters: nextStageData.artifact, depends_on: [] },
          inputs: context.inputs, accepted_cohort_outputs: context.state.accepted_outputs, context: context.run_context,
          outputs: contract.outputs.map((output) => ({ output_name: output.name, artifact_type: output.artifact_type,
            release: output.release, attention: output.attention ?? "none" })),
          identity: `attempt:${attempt_id}`,
          capability_seed: await dependencies.records.load_work_order_capability_seed(),
          session_launch: committedSessionLaunch(launch_transition_id, launch,
            stageData.build_state.verified_pull_request?.url ?? null),
          attempt_id: attempt_id as unknown as WorkOrderId,
          attempt_workflow_id: attemptWorkflowId(attempt_id),
          ...(cohort ? { build_cohort: cohort } : {}),
        });
        return resolved.request;
      },
    },
  };
};

const launchReasonFor = (event: BuildCohortEvent): CohortStepDecision["event"]["launch_reason"] => {
  if (event.kind === "stage_started") return "initial";
  if (event.kind === "build_review_approved" || event.kind === "build_review_revision_requested"
    || event.kind === "assessment_review_approved" || event.kind === "assessment_review_revision_requested") return "gate_decided";
  if (event.kind === "operator_retry_requested") return "retry";
  return "artifact_accepted";
};

/**
 * The validated machine for one stage contract and one pinned bundle.
 *
 * `createBuildCohortMachine` checks the whole role x launch-reason prompt matrix
 * before a cohort can run, so a later transition selects an already pinned
 * prompt cell rather than consulting a mutable bundle while rendering a session.
 * Only the cells this stage declares are offered to it: a bundle carries every
 * stage's cells, and an unrecognised one is a validation failure by design.
 */
const buildMachineFor = (contract: CompiledStageContract, bundle: readonly PromptBundleEntry[]): BuildCohortMachine => {
  const declared = new Set(definitionConfigOf(contract).prompt_matrix
    .map((entry) => `${entry.session_role}:${entry.launch_reason}:${entry.template_path}`));
  const created = createBuildCohortMachine({
    required_build_set: requiredBuildSet(contract),
    prompts: bundle.filter((entry) => declared.has(`${entry.session_role}:${entry.launch_reason}:${entry.template_path}`)),
  });
  if (!created.ok) throw new Error(`stage '${contract.stage_key}' has an invalid cohort machine: ${created.error}`);
  return created.value;
};

/** The roles this driver can launch, for a composition that wants to check them. */
export const DEV_FLOW_COHORT_ROLES: readonly BuildSessionRole[] = ["build", "assessment"];
