import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactId, ExecutionId, StageInstanceId, UnitId } from "../domain/primitives";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");

const workflowId = process.env.PROOF_WORKFLOW_ID ?? "cohort-b-gate-proof";
const mode = process.env.PROOF_MODE ?? "start";

DBOS.setConfig({
  name: "oakridge-dbos-gate-proof",
  systemDatabaseUrl: databaseUrl,
  applicationVersion: "cohort-b-gate",
  logLevel: "warn",
});
const { durableGateWorkflow } = await import("../workflows/gate");

await DBOS.launch();
try {
  if (mode === "start") {
    await DBOS.startWorkflow(durableGateWorkflow, { workflowID: workflowId })({
      stage_instance_id: "stage-proof" as StageInstanceId,
      execution_id: "execution-proof" as ExecutionId,
      unit_id: "unit-proof" as UnitId,
      artifact_revision_id: "artifact-revision-proof" as ArtifactId,
      gate_step: "artifact-approval",
      actions: ["approve", "request_revision"],
    });
    const pending = await DBOS.getEvent(workflowId, "gate-state", { timeoutSeconds: 10 });
    console.log(JSON.stringify(pending));
  } else if (mode === "resume") {
    await DBOS.send(workflowId, {
      action: "pass",
      artifact_revision_id: "artifact-revision-proof" as ArtifactId,
      gate_step: "artifact-approval",
    }, "gate-command", "gate-proof-command");
    const result = await DBOS.retrieveWorkflow(workflowId).getResult();
    const closed = await DBOS.getEvent(workflowId, "gate-state", { timeoutSeconds: 10 });
    console.log(JSON.stringify({ result, closed }));
  } else {
    throw new Error(`unknown PROOF_MODE: ${mode}`);
  }
} finally {
  await Promise.race([DBOS.shutdown(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}
process.exit(0);
