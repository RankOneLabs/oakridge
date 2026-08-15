import { DBOS } from "@dbos-inc/dbos-sdk";

import { materializeBatch } from "../compiler/materialize-units";
import type { StageInstanceId, WorkflowRunId } from "../domain/primitives";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");

DBOS.setConfig({ name: "oakridge-dbos-stub", systemDatabaseUrl: databaseUrl, applicationVersion: "cohort-b-stub", logLevel: "warn" });
const { deliveryProofWorkflow } = await import("../workflows/delivery-topology");
const units = materializeBatch(
  [{ id: "foundation", depends_on: [], delay_ms: Number(process.env.STUB_DELAY_MS ?? 0) }, { id: "api", depends_on: ["foundation"] }, { id: "ui", depends_on: ["foundation"] }],
  { unit_id_path: "/id", depends_on_path: "/depends_on" },
);
if (!units.ok) throw new Error(units.error.detail);

await DBOS.launch();
try {
  const handle = await DBOS.startWorkflow(deliveryProofWorkflow, { workflowID: process.env.PROOF_WORKFLOW_ID ?? `cohort-b-delivery-${crypto.randomUUID()}` })({
    run_id: crypto.randomUUID() as WorkflowRunId,
    producer_stage_instance_id: crypto.randomUUID() as StageInstanceId,
    consumer_stage_instance_id: crypto.randomUUID() as StageInstanceId,
    units: units.value,
  });
  const result = await handle.getResult();
  console.log(JSON.stringify(result));
} finally {
  await Promise.race([DBOS.shutdown(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}
process.exit(0);
