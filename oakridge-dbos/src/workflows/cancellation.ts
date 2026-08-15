import { DBOS } from "@dbos-inc/dbos-sdk";

import type { CancellationExecutionTarget, CancellationWaitTarget } from "../domain/rerun";
import { executorFenceWorkflow } from "./executor-topology";

export interface CancellationControlInput { readonly root_workflow_id: string; readonly reason: string | null; readonly requested_at: string }
export interface CancellationControlResult { readonly root_workflow_id: string; readonly fenced_execution_count: number }
export interface CancellationControlServices {
  list_execution_targets(root_workflow_id: string): Promise<readonly CancellationExecutionTarget[]>;
  terminalize_pending_waits(root_workflow_id: string, reason: string | null, at: string): Promise<readonly CancellationWaitTarget[]>;
  finish_started_stages(root_workflow_id: string, at: string, reason: string | null): Promise<void>;
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

export const cancellationControlWorkflow = DBOS.registerWorkflow(async (input: CancellationControlInput): Promise<CancellationControlResult> => {
  await DBOS.setEvent("cancellation-state", { status: "fencing", ...input });
  const targets = await loadCancellationTargetsStep(input.root_workflow_id);
  const fences = [];
  for (const target of targets) {
    fences.push(await DBOS.startWorkflow(executorFenceWorkflow, { workflowID: `${DBOS.workflowID}:fence:${target.execution_id}` })({
      execution_id: target.execution_id, executor_type: target.executor_type,
      ...(target.external_reference ? { external_reference: target.external_reference } : {}),
    }));
  }
  for (const fence of await DBOS.waitAll(fences)) await fence.getResult();
  await DBOS.setEvent("cancellation-state", { status: "closing_domain", ...input });
  await finishCancelledStagesStep(input);
  await DBOS.setEvent("cancellation-state", { status: "terminalizing_waits", ...input });
  const waits = await terminalizeCancellationWaitsStep(input);
  for (const wait of waits) await DBOS.send(wait.workflow_id, { kind: "withdraw" }, wait.kind === "gate" ? "gate-command" : "handoff-command", `${DBOS.workflowID}:${wait.kind}:${wait.workflow_id}:withdraw`);
  for (const wait of waits) {
    const key = wait.kind === "gate" ? "gate-state" : "handoff-state";
    await DBOS.retrieveWorkflow(wait.workflow_id).getResult();
    const state = await DBOS.getEvent<{ readonly status?: string }>(wait.workflow_id, key, { timeoutSeconds: 0 });
    if (state?.status !== "withdrawn" && state?.status !== "superseded" && state?.status !== "closed" && state?.status !== "released" && state?.status !== "revision_requested") {
      throw new Error(`cancellation wait '${wait.workflow_id}' completed without a terminal event`);
    }
  }
  await DBOS.setEvent("cancellation-state", { status: "cancelling", ...input });
  await DBOS.cancelWorkflow(input.root_workflow_id, { cancelChildren: true });
  await DBOS.setEvent("cancellation-state", { status: "complete", ...input });
  return { root_workflow_id: input.root_workflow_id, fenced_execution_count: targets.length };
}, { name: "oakridgeCancellationControlWorkflow" });
