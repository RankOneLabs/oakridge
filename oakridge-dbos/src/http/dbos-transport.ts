import type { ArtifactWorkflowMessage } from "./artifact-callback";
import type { GateWorkflowState, HandoffWorkflowState } from "./gate-resume";
import type { GateCommand } from "../workflows/gate";
import type { HandoffCommand } from "../workflows/handoff";
import type { StageAdmissionState } from "../domain/runs";
import type { StageCommand } from "../workflows/production-topology";

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

export const getGateWorkflowState = async (workflow_id: string): Promise<GateWorkflowState | null> =>
  client().getEvent<GateWorkflowState>(workflow_id, "gate-state", { timeoutSeconds: 0 });

export const sendGateWorkflowCommand = async (workflow_id: string, command: GateCommand, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, command, "gate-command", idempotency_key);
};

export const getHandoffWorkflowState = async (workflow_id: string): Promise<HandoffWorkflowState | null> =>
  client().getEvent<HandoffWorkflowState>(workflow_id, "handoff-state", { timeoutSeconds: 0 });

export const sendHandoffWorkflowCommand = async (workflow_id: string, command: HandoffCommand, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, command, "handoff-command", idempotency_key);
};

export const getStageAdmissionState = async (workflow_id: string): Promise<StageAdmissionState | null> =>
  client().getEvent<StageAdmissionState>(workflow_id, "stage-admission-state", { timeoutSeconds: 0 });

export const sendStageCommand = async (workflow_id: string, command: StageCommand, idempotency_key: string): Promise<void> => {
  await client().send(workflow_id, command, "stage-command", idempotency_key);
};
