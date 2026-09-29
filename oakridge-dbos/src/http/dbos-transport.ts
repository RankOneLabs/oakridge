import { cohortMachineWorkflowId } from "../decision/ids";
import { runRecordWorkflowId } from "../domain/workflow-ids";
import type { CohortId, WorkflowRunId } from "../domain/primitives";

const RUN_RECORD_WAKE_TOPIC = "oakridge-v15-machine-wake";

export interface DbosTransportClient {
  send(destination_id: string, message: unknown, topic?: string, idempotency_key?: string): Promise<void>;
}

let transportClient: DbosTransportClient | null = null;
export const registerDbosTransportClient = (client: DbosTransportClient): void => { transportClient = client; };
const client = (): DbosTransportClient => {
  if (!transportClient) throw new Error("DBOS external transport client is not registered");
  return transportClient;
};

/**
 * Wakes a decision machine sooner than its bounded recheck. The payload is
 * empty on purpose — no machine reads it, only that a send arrived, so a lost,
 * duplicated, or reordered delivery cannot change what it decides.
 * `idempotency_key` only makes a retried *send* itself idempotent; it plays no
 * part in the run's own idempotency.
 */
export const sendRunWakeHint = async (run_id: WorkflowRunId, idempotency_key: string): Promise<void> => {
  await client().send(runRecordWorkflowId(run_id), {}, RUN_RECORD_WAKE_TOPIC, idempotency_key);
};

/**
 * The same hint addressed to one cohort's machine.
 *
 * A gate decision and an operator retry both change what a *cohort* decides,
 * not what the run decides: `derive` reads committed cohort status, so waking
 * the root alone would have it re-read a picture nothing had changed yet.
 */
export const sendCohortWakeHint = async (cohort_id: CohortId, idempotency_key: string): Promise<void> => {
  await client().send(cohortMachineWorkflowId(cohort_id), {}, RUN_RECORD_WAKE_TOPIC, idempotency_key);
};

/** The one topic every machine's bounded `recv` listens on. */
export const MACHINE_WAKE_TOPIC = RUN_RECORD_WAKE_TOPIC;
