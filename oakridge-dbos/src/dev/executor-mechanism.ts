import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import { executorOperationIdForAttempt, type ExecutionAttemptId } from "../domain/primitives";
import { findExecutorAdapter } from "../workflows/executor-topology";

export interface ExecutorMechanismResult {
  readonly external_reference: ExternalExecutionReference;
  readonly terminal_observation: ExecutorTerminalObservation;
}

/**
 * Single-shot executor drive, for proving an adapter end to end without a run
 * around it. It lives under `src/dev/` because importing a module is what
 * registers its workflows with DBOS: while this sat in `executor-topology.ts`
 * the production backend registered a workflow nothing could ever start.
 *
 * The production path is `terminalObserverWorkflow`, which owns a durable poll.
 * This has no such loop, so an adapter answering `pending` here is a wiring
 * error rather than a state to wait through.
 */
const runExecutorMechanismStep = DBOS.registerStep(async (request: ExecutionRequest): Promise<ExecutorMechanismResult> => {
  const adapter = findExecutorAdapter(request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${request.executor_type}' is not registered`);
  const attemptId = (DBOS.workflowID ?? request.execution_id) as ExecutionAttemptId;
  const externalReference = await adapter.start_or_attach(request, executorOperationIdForAttempt(attemptId));
  const attempt = await adapter.observe_terminal(request.execution_id, externalReference);
  if (attempt.kind === "pending") throw new Error(`executor adapter '${request.executor_type}' returned a pending observation to the single-shot mechanism step`);
  return { external_reference: externalReference, terminal_observation: attempt.observation };
}, { name: "oakridgeRunExecutorMechanismStep", retriesAllowed: true });

/**
 * Reports executor mechanism state only. Its successful return does not satisfy
 * an Oakridge unit or StageInstance; artifact-contract evaluation remains the
 * caller's next workflow operation.
 */
export const executorBackedExecutionWorkflow = DBOS.registerWorkflow(async (request: ExecutionRequest): Promise<ExecutorMechanismResult> => {
  return runExecutorMechanismStep(request);
}, { name: "oakridgeExecutorBackedExecutionWorkflow" });
