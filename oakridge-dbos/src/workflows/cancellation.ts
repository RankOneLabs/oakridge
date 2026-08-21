import { DBOS } from "@dbos-inc/dbos-sdk";

import { selectCancellationWaitSplit, type CancellationExecutionTarget, type CancellationWaitTarget } from "../domain/rerun";
import { executorFenceWorkflowId } from "../domain/workflow-ids";
import { executorFenceWorkflow } from "./executor-topology";

export interface CancellationControlInput { readonly root_workflow_id: string; readonly reason: string | null; readonly requested_at: string }
export interface CancellationControlResult { readonly root_workflow_id: string; readonly fenced_execution_count: number }
export interface CancellationControlServices {
  list_execution_targets(root_workflow_id: string): Promise<readonly CancellationExecutionTarget[]>;
  terminalize_pending_waits(root_workflow_id: string, reason: string | null, at: string): Promise<readonly CancellationWaitTarget[]>;
  finish_started_stages(root_workflow_id: string, at: string, reason: string | null): Promise<void>;
  count_open_waits(command_workflow_id: string): Promise<number>;
  close_orphaned_waits(command_workflow_id: string, at: string): Promise<void>;
}

let services: CancellationControlServices | null = null;
export const registerCancellationControlServices = (value: CancellationControlServices): void => { services = value; };
const controlServices = (): CancellationControlServices => {
  if (!services) throw new Error("cancellation control services are not registered");
  return services;
};

const loadCancellationTargetsStep = DBOS.registerStep(async (root: string) => controlServices().list_execution_targets(root),
  { name: "oakridgeLoadCancellationTargetsStep", retriesAllowed: true });
const terminalizeCancellationWaitsStep = DBOS.registerStep(async (input: CancellationControlInput) =>
  controlServices().terminalize_pending_waits(input.root_workflow_id, input.reason, input.requested_at),
{ name: "oakridgeTerminalizeCancellationWaitsStep", retriesAllowed: true });
const finishCancelledStagesStep = DBOS.registerStep(async (input: CancellationControlInput) =>
  controlServices().finish_started_stages(input.root_workflow_id, input.requested_at, input.reason),
{ name: "oakridgeFinishCancelledStagesStep", retriesAllowed: true });
const countOpenWaitsStep = DBOS.registerStep(async (command_workflow_id: string) =>
  controlServices().count_open_waits(command_workflow_id),
{ name: "oakridgeCountOpenWaitsStep", retriesAllowed: true });
const closeOrphanedWaitsStep = DBOS.registerStep(async (input: { readonly command_workflow_id: string; readonly at: string }) =>
  controlServices().close_orphaned_waits(input.command_workflow_id, input.at),
{ name: "oakridgeCloseOrphanedWaitsStep", retriesAllowed: true });

/** Progress notification, so a caller can publish its own state event. */
export type AttemptContainmentPhase = "fencing" | "closing_domain" | "terminalizing_waits";

/**
 * Stop everything an attempt still has running: fence its executors, close its
 * unfinished stages in the domain, and withdraw the gate and handoff waits that
 * would otherwise sit pending forever.
 *
 * Shared by operator cancellation and by a run ending because one of its stages
 * failed. The siblings of a failed stage are in exactly the position of a
 * cancelled run's stages — nothing downstream will ever consume their output —
 * and leaving them alone kept their delegated sessions running, and billing,
 * with no stage record ever written for them.
 *
 * Callers cancel their own workflows afterwards: an operator cancels the
 * attempt root, while a run failing from the inside cancels its stage
 * coordinators, because it cannot cancel the workflow it is running in.
 */
export const containAttempt = async (input: CancellationControlInput, announce: (phase: AttemptContainmentPhase) => Promise<void>): Promise<number> => {
  // Read once and asserted, because it names both the fence workflows and the
  // withdraw idempotency keys below. An empty owner prefix would let two
  // attempts collide on one fence ID, and the loser's executors would simply
  // never be fenced — a live agent left running, with nothing reporting it.
  const containerId = DBOS.workflowID;
  if (!containerId) throw new Error("attempt containment requires a workflow ID");
  await announce("fencing");
  const targets = await loadCancellationTargetsStep(input.root_workflow_id);
  const fences = [];
  for (const target of targets) {
    fences.push(await DBOS.startWorkflow(executorFenceWorkflow, { workflowID: executorFenceWorkflowId(containerId, target.execution_id) })({
      execution_id: target.execution_id, executor_type: target.executor_type,
      // An execution that never reached an executor has nothing to fence, and
      // says so; the adapter must never have to guess from in-process memory.
      external_reference: target.external_reference ?? { kind: "none" },
    }));
  }
  for (const fence of await DBOS.waitAll(fences)) await fence.getResult();
  await announce("closing_domain");
  // Only stages with no recorded end are touched, so a stage that already
  // finished — including the one whose failure started this — keeps its outcome.
  await finishCancelledStagesStep(input);
  await announce("terminalizing_waits");
  const waits = await terminalizeCancellationWaitsStep(input);
  // The executor's own version is read here rather than carried in the input:
  // the question is whether *this* process can recover a wait, so it has to be
  // answered by the process that would be doing the recovering.
  const { answerable, orphaned } = selectCancellationWaitSplit(waits, DBOS.applicationVersion);
  for (const { wait, holder_application_version } of orphaned) {
    // Terminalized rather than merely skipped: a PENDING row nothing will ever
    // resume still reads as live to every other liveness check in the system.
    // Leaving it is how one orphan goes on to hold a session hostage.
    DBOS.logger.warn(`cancellation wait '${wait.workflow_id}' was left PENDING by application version ${holder_application_version}, which this executor (${DBOS.applicationVersion}) cannot recover; cancelling it directly rather than awaiting a withdrawal it can never acknowledge`);
    await DBOS.cancelWorkflow(wait.workflow_id);
    // The single exception to owner-closes: the owner is provably dead, so its
    // open rows are closed on its behalf — as withdrawn, with cancellation's
    // own timestamp — instead of sitting open forever behind lifecycle joins.
    await closeOrphanedWaitsStep({ command_workflow_id: wait.workflow_id, at: input.requested_at });
  }
  for (const wait of answerable) await DBOS.send(wait.workflow_id, { kind: "withdraw" }, wait.kind === "gate" ? "gate-command" : "handoff-command", `${containerId}:${wait.kind}:${wait.workflow_id}:withdraw`);
  for (const wait of answerable) {
    await DBOS.retrieveWorkflow(wait.workflow_id).getResult();
    if (await countOpenWaitsStep(wait.workflow_id) > 0) {
      throw new Error(`cancellation wait '${wait.workflow_id}' completed without closing its wait row`);
    }
  }
  return targets.length;
};

export const cancellationControlWorkflow = DBOS.registerWorkflow(async (input: CancellationControlInput): Promise<CancellationControlResult> => {
  const fenced = await containAttempt(input, async (status) => { await DBOS.setEvent("cancellation-state", { status, ...input }); });
  await DBOS.setEvent("cancellation-state", { status: "cancelling", ...input });
  await DBOS.cancelWorkflow(input.root_workflow_id, { cancelChildren: true });
  await DBOS.setEvent("cancellation-state", { status: "complete", ...input });
  return { root_workflow_id: input.root_workflow_id, fenced_execution_count: fenced };
}, { name: "oakridgeCancellationControlWorkflow" });
