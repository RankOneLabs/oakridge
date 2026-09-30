/**
 * The cohort driver for a deterministic stage — one whose work is a service
 * action rather than an agent session.
 *
 * `provision_repository_refs` is the one shipped example: it guarantees a branch
 * in a checkout and publishes the refs it guaranteed. There is no review, no
 * revision and no second role, so the machine is three facts wide — launch the
 * action, wait for its output, complete — and it is worth having as its own
 * driver rather than a mode of the build machine, which would have to carry six
 * phases it can never enter.
 */
import { attemptWorkflowId } from "../decision/ids";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { AttemptId, CohortId, JsonValue, RunTransitionId, StageInstanceId, UnitId, WorkOrderId } from "../domain/primitives";
import { hasOwn, readOwn } from "../domain/records";
import type { OpenCohort } from "../domain/run-record";
import { resolveAttemptExecution } from "../runtime/resolve-work-order";
import type { RunRecordRepository } from "../storage/repositories";
import type { CohortMachineDriver, CohortStepContext, CohortStepDecision } from "../workflows/run-record-topology";
import { cohortIdFor, resolveCohortRoster, selectCohortOutputsSatisfied } from "./cohort-roster";

/** `oakridge.cohort.stage_data` for a deterministic cohort. */
interface DeterministicCohortStageData {
  readonly unit_id: string;
  /** The roster item, under the key the operator projections read it from. */
  readonly artifact: JsonValue;
  /** How many times this cohort has launched its action — what makes a relaunch visible. */
  readonly launched: number;
}

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contractOf = (value: JsonValue): CompiledStageContract => {
  if (!isObject(value)) throw new Error("stage contract is not an object");
  return value as unknown as CompiledStageContract;
};

const stageDataOf = (state: CohortStepContext["state"]): DeterministicCohortStageData => {
  const stored = state.stage_data;
  return {
    unit_id: isObject(stored) && typeof stored.unit_id === "string" ? stored.unit_id : state.cohort_key,
    artifact: isObject(stored) ? readOwn(stored, "artifact") ?? null : null,
    launched: isObject(stored) && hasOwn(stored, "launched") && typeof stored.launched === "number" ? stored.launched : 0,
  };
};

const encode = (data: DeterministicCohortStageData): JsonValue =>
  ({ unit_id: data.unit_id, artifact: data.artifact, launched: data.launched });

export interface DeterministicCohortDriverDependencies {
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  /** The stage type this driver is registered for, and the executor it dispatches to. */
  readonly stage_type: string;
}

export const createDeterministicCohortDriver = (dependencies: DeterministicCohortDriverDependencies): CohortMachineDriver => ({
  stage_type: dependencies.stage_type,

  async open_cohorts(input): Promise<readonly OpenCohort[]> {
    const contract = contractOf(input.stage_contract);
    return resolveCohortRoster(contract, input.run_context, input.inputs).map((entry) => ({
      id: cohortIdFor(input.stage_instance_id, entry.cohort_key),
      cohort_key: entry.cohort_key,
      stage_data: encode({ unit_id: entry.cohort_key, artifact: entry.item, launched: 0 }),
    }));
  },

  /**
   * Launch, then complete when the output has been accepted.
   *
   * Completion is keyed on *acceptance*, not on the attempt's terminal
   * observation: a service action that returned without publishing has not done
   * its job, and a cohort that completed on the return value would let the
   * downstream stage consume a slot nothing filled.
   */
  async step(context: CohortStepContext): Promise<CohortStepDecision | null> {
    const contract = contractOf(context.stage_contract);
    const stageData = stageDataOf(context.state);
    if (stageData.launched > 0 && context.state.open_waits.length === 0
      && selectCohortOutputsSatisfied(contract, context, context.state.accepted_outputs)) {
      return {
        event: {
          change: { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } },
          stage_data: encode(stageData),
          effect: { kind: "none" },
          launch_reason: "artifact_accepted",
          actor: "core",
        },
        launch: null,
      };
    }
    // Already running: the attempt workflow owns the wait, and its publication
    // is what wakes this machine again.
    if (stageData.launched > context.state.attempt_count - 1 && context.state.attempt_count > 0) return null;

    const launched = { ...stageData, launched: stageData.launched + 1 };
    return {
      event: {
        change: { status: "active", blocked_reason: null, next_actor: "service", outcome: null },
        stage_data: encode(launched),
        effect: { kind: "start_attempt", cohort_id: context.state.cohort_id, attempt_number: launched.launched },
        launch_reason: stageData.launched === 0 ? "initial" : "retry",
        actor: "core",
      },
      launch: {
        attempt_number: context.state.attempt_count + 1,
        adapter_type: contract.executor.executor_type,
        resolve_request: async (attempt_id: AttemptId, _launch_transition_id: RunTransitionId) => {
          const resolved = await resolveAttemptExecution({
            run_id: context.state.run_id, stage: contract, stage_instance_id: context.state.stage_instance_id,
            unit: { unit_id: context.state.cohort_key as UnitId, parameters: stageData.artifact, depends_on: [] },
            inputs: context.inputs, context: context.run_context,
            outputs: contract.outputs.map((output) => ({ output_name: output.name, artifact_type: output.artifact_type,
              release: output.release, attention: output.attention ?? "none" })),
            identity: `attempt:${attempt_id}`,
            capability_seed: await dependencies.records.load_work_order_capability_seed(),
            attempt_id: attempt_id as unknown as WorkOrderId,
            attempt_workflow_id: attemptWorkflowId(attempt_id),
          });
          return resolved.request;
        },
      },
    };
  },

  /** A deterministic stage has no external facts to take in. */
  apply_event: async () => null,
});

/** Re-exported so composition can address a deterministic cohort by key. */
export { cohortIdFor as deterministicCohortIdFor };
export type { CohortId, StageInstanceId };
