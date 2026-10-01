/**
 * The `delegated_session` stage type's driver.
 *
 * One stage type, two machines: dev-flow's build stage declares two session
 * roles and two sequential gates, every other delegated stage declares one role
 * and one gate. Which machine a cohort runs is decided from its *contract* —
 * how many roles its pinned prompt matrix declares — not from the stage's name,
 * because a name check would break the moment a definition called its build
 * stage something else, and silently: the cohort would run the wrong machine.
 */
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { JsonValue, WorkflowRunId } from "../domain/primitives";
import type { PromptBundleEntry } from "../domain/workflow";
import type { DevFlowPullRequestRepository, RunRecordRepository } from "../storage/repositories";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { CohortMachineDriver, CohortStepContext, CohortStepDecision } from "../workflows/run-record-topology";
import { createDevFlowCohortDriver } from "./dev-flow-cohort";
import { createSingleRoleCohortDriver, declaresMultipleRoles } from "./single-role-cohort";

export const DELEGATED_SESSION_STAGE_TYPE = "delegated_session";

export interface DelegatedSessionCohortDriverDependencies {
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  readonly pull_requests: DevFlowPullRequestRepository;
  readonly git: GitCommandRunner;
  readonly verify_build_pull_request: import("./dev-flow-cohort").DevFlowCohortDriverDependencies["verify_build_pull_request"];
  load_prompt_bundle(run_id: WorkflowRunId): Promise<readonly PromptBundleEntry[]>;
}

const isObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contractOf = (value: JsonValue): CompiledStageContract => {
  if (!isObject(value)) throw new Error("stage contract is not an object");
  return value as unknown as CompiledStageContract;
};

export const createDelegatedSessionCohortDriver = (
  dependencies: DelegatedSessionCohortDriverDependencies,
): CohortMachineDriver => {
  const multiRole = createDevFlowCohortDriver({ ...dependencies, stage_type: DELEGATED_SESSION_STAGE_TYPE });
  const singleRole = createSingleRoleCohortDriver({ ...dependencies, stage_type: DELEGATED_SESSION_STAGE_TYPE });
  const forContract = (stage_contract: JsonValue): CohortMachineDriver =>
    declaresMultipleRoles(contractOf(stage_contract)) ? multiRole : singleRole;

  return {
    stage_type: DELEGATED_SESSION_STAGE_TYPE,
    open_cohorts: (input) => forContract(input.stage_contract).open_cohorts(input),
    step: (context: CohortStepContext): Promise<CohortStepDecision | null> =>
      forContract(context.stage_contract).step(context),
    apply_event: (context: CohortStepContext, event: JsonValue): Promise<CohortStepDecision | null> =>
      forContract(context.stage_contract).apply_event(context, event),
  };
};
