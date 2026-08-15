import { DBOS } from "@dbos-inc/dbos-sdk";

import { KbblExecutorAdapter } from "../adapters/kbbl";
import type { ExecutionRequest } from "../domain/execution";
import type { ExecutionId, StageInstanceId, UnitId } from "../domain/primitives";

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
const kbblUrl = process.env.KBBL_URL;
if (!kbblUrl) throw new Error("KBBL_URL is required");

DBOS.setConfig({ name: "oakridge-dbos-kbbl-proof", systemDatabaseUrl: databaseUrl, applicationVersion: "cohort-c-kbbl", logLevel: "warn" });
const { executorBackedExecutionWorkflow, registerExecutorAdapter } = await import("../workflows/executor-topology");
registerExecutorAdapter(new KbblExecutorAdapter({ base_url: kbblUrl, executor_function_identity: "oakridgeRunExecutorMechanismStep" }));

const executionId = "cohort-c-live-execution" as ExecutionId;
const request: ExecutionRequest = {
  execution_id: executionId,
  stage_instance_id: "cohort-c-live-stage" as StageInstanceId,
  unit_id: "cohort-c-live-unit" as UnitId,
  executor_type: "delegated_session",
  resolved_config: {
    runtime: "claude-code",
    rendered_prompt: "Reply with exactly: OAKRIDGE_DBOS_KBBL_PROOF_READY and then wait for further instructions.",
    workdir: process.cwd(),
    session_name: "oakridge-dbos-kbbl-proof",
    model: null,
    effort: null,
    artifact_id: null,
  },
  inputs: [],
  declared_outputs: [],
};

await DBOS.launch();
try {
  const handle = await DBOS.startWorkflow(executorBackedExecutionWorkflow, { workflowID: process.env.PROOF_WORKFLOW_ID ?? "cohort-c-kbbl-recovery-proof" })(request);
  console.log(JSON.stringify(await handle.getResult()));
} finally {
  await DBOS.shutdown();
}
