import type { ArtifactWorkflowMessage } from "./artifact-callback";
import type { GateCommand } from "../workflows/gate";
import type { HandoffCommand } from "../workflows/handoff";
import type { StageAdmissionState } from "../domain/runs";
import type { StageCommand } from "../workflows/production-topology";
import { RUN_RECORD_WAKE_TOPIC } from "../workflows/run-record-topology";

export interface DbosTransportClient {
  send(destination_id: string, message: unknown, topic?: string, idempotency_key?: string): Promise<void>;
  getEvent<Value>(workflow_id: string, key: string, options: { readonly timeoutSeconds: number }): Promise<Value | null>;
}

let transportClient: DbosTransportClient | null = null;
export const registerDbosTransportClient = (client: DbosTransportClient): void => { transportClient = client; };
const client = (): DbosTransportClient => {
  if (!transportClient) throw new Error("DBOS external transport client is not registered");
  return transportClient;
};

export const sendArtifactWorkflowMessage = async (workflow_id: string, message: ArtifactWorkflowMessage, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, message, "execution-event", idempotency_key);
};

export const sendGateWorkflowCommand = async (workflow_id: string, command: GateCommand, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, command, "gate-command", idempotency_key);
};

export const sendHandoffWorkflowCommand = async (workflow_id: string, command: HandoffCommand, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, command, "handoff-command", idempotency_key);
};

export const getStageAdmissionState = async (workflow_id: string): Promise<StageAdmissionState | null> =>
  client().getEvent<StageAdmissionState>(workflow_id, "stage-admission-state", { timeoutSeconds: 0 });

export const sendStageCommand = async (workflow_id: string, command: StageCommand, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, command, "stage-command", idempotency_key);
};

/**
 * Wakes a v2 root run workflow sooner than its bounded recheck. The payload
 * is empty on purpose — `runRecordWorkflow` never reads it, only that a send
 * arrived, so a lost, duplicated, or reordered delivery cannot change what it
 * decides. `idempotency_key` only makes a retried *send* itself idempotent;
 * it plays no part in the run's own idempotency.
 */
export const sendRunWakeHint = async (run_id: string, idempotency_key: string): Promise<void> => {
  await client().send(run_id, {}, RUN_RECORD_WAKE_TOPIC, idempotency_key);
};
