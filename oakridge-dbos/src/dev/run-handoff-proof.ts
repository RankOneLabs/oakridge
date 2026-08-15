import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactRevision } from "../domain/artifacts";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import { durableHandoffWorkflow } from "../workflows/handoff";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
const workflowId = process.env.PROOF_WORKFLOW_ID ?? "cohort-d-handoff-proof";
const handoffId = `${workflowId}:handoff`;
const mode = process.env.PROOF_MODE ?? "start";

DBOS.setConfig({ name: "oakridge-dbos-handoff-proof", systemDatabaseUrl: databaseUrl, applicationVersion: "cohort-d-handoff", logLevel: "warn" });

const artifact: ArtifactRevision = {
  id: "00000000-0000-0000-0000-000000000101" as ArtifactId, chain_id: "00000000-0000-0000-0000-000000000101" as ArtifactId,
  run_id: "00000000-0000-0000-0000-000000000102" as WorkflowRunId, stage_instance_id: "00000000-0000-0000-0000-000000000103" as StageInstanceId,
  execution_id: "proof-execution" as ExecutionId, unit_id: "proof-unit" as UnitId, output_name: "build_result", artifact_type: "dev.build_result",
  label: null, body: {}, version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-14T12:00:00Z",
};

const proofParent = DBOS.registerWorkflow(async (): Promise<unknown> => {
  const child = await DBOS.startWorkflow(durableHandoffWorkflow, { workflowID: handoffId })({ artifact, downstream_role: "assessment", external_wait_kind: "github_review", parent_workflow_id: DBOS.workflowID! });
  return child.getResult();
}, { name: "oakridgeHandoffProofParent" });

await DBOS.launch();
try {
  if (mode === "start") {
    await DBOS.startWorkflow(proofParent, { workflowID: workflowId })();
    console.log(JSON.stringify(await DBOS.getEvent(handoffId, "handoff-state", { timeoutSeconds: 10 })));
  } else if (mode === "approve") {
    await DBOS.send(handoffId, { kind: "downstream_decision", action: "approve", decision_artifact_id: "assessment-1", feedback: null }, "handoff-command", "assessment-approval-1");
    let state: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = await DBOS.getEvent(handoffId, "handoff-state", { timeoutSeconds: 1 });
      if (typeof state === "object" && state !== null && "status" in state && state.status === "awaiting_external") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    console.log(JSON.stringify(state));
  } else if (mode === "external") {
    await DBOS.send(handoffId, { kind: "external_completed", external_kind: "github_review", correlation_id: "review-42" }, "handoff-command", "external-review-42");
    let state: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = await DBOS.getEvent(handoffId, "handoff-state", { timeoutSeconds: 1 });
      if (typeof state === "object" && state !== null && "status" in state && state.status === "released") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    console.log(JSON.stringify({ state, result: state && typeof state === "object" && "status" in state && state.status === "released" ? await DBOS.retrieveWorkflow(workflowId).getResult() : null }));
  } else throw new Error(`unknown PROOF_MODE: ${mode}`);
} finally {
  await Promise.race([DBOS.shutdown(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}
process.exit(0);
