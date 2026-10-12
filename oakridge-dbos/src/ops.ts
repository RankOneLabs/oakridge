import { DBOS } from "@dbos-inc/dbos-sdk";
import { openDatabase } from "./storage/database";
import { migrateEmptyDatabase } from "./storage/migrate";
import { selectApplicationVersion } from "./workflows/engine-version";
import { currentRunGeneration, ensureRunRecoveryFork, forkStartStep, runGenerationOf, runWorkflowId } from "./workflows/topology";

/** Recovery forks onto the version of the running engine and its WASM core. */
function opsApplicationVersion(env: NodeJS.ProcessEnv = process.env): string {
  return selectApplicationVersion(undefined, env);
}

type OpsCommand = readonly ["workflows", "list" | "inspect" | "recover", ...string[]] | readonly ["migrate"];

export async function runOps(args: readonly string[], database_url: string | undefined = process.env.DBOS_SYSTEM_DATABASE_URL): Promise<unknown> {
  const command = (args[0] === "--" ? args.slice(1) : args) as OpsCommand;
  if (!database_url) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
  if (command[0] === "migrate") {
    const db = openDatabase(database_url);
    try { await migrateEmptyDatabase(db); return { migrated: true }; }
    finally { await db.destroy(); }
  }
  if (command[0] !== "workflows" || !["list", "inspect", "recover"].includes(command[1]))
    throw new Error("usage: ops -- workflows list|inspect <id>|recover <id> OR ops -- migrate");
  const workflow_id = command[2];
  if (command[1] !== "list" && !workflow_id) throw new Error(`${command[1]} requires a workflow id`);
  // The operator process must not recover production workflows without their services.
  DBOS.setConfig({ name: "oakridge-ops", systemDatabaseUrl: database_url, applicationVersion: "oakridge-ops" });
  await DBOS.launch();
  try {
    if (command[1] === "list") return DBOS.listWorkflows({ workflowName: ["oakridgeRunWorkflow", "oakridgeEffectWorkflow", "oakridgeCleanupWorkflow"], limit: 200 });
    const status = await DBOS.getWorkflowStatus(workflow_id!);
    if (!status) throw new Error(`workflow ${workflow_id} not found`);
    if (command[1] === "inspect") return { status, steps: await DBOS.listWorkflowSteps(workflow_id!) };
    if (status.status === "CANCELLED") {
      const resumed = await DBOS.resumeWorkflow(workflow_id!);
      return { workflowID: resumed.workflowID, action: "resumed" };
    }
    if (status.status !== "ERROR") throw new Error(`workflow ${workflow_id} is ${status.status}; recover requires ERROR or CANCELLED`);
    const steps = await DBOS.listWorkflowSteps(workflow_id!) ?? [];
    const startStep = forkStartStep(steps);
    let newWorkflowID: string | undefined;
    if (status.workflowName === "oakridgeRunWorkflow") {
      if (typeof status.input?.[0] !== "string") throw new Error(`run workflow ${workflow_id} has no run identity`);
      const run_id = status.input[0];
      // The newest run workflow is the run's current generation; only it may be recovered.
      const generation = runGenerationOf(run_id, workflow_id!);
      if (generation === null || await currentRunGeneration(run_id) !== generation)
        throw new Error(`run workflow ${workflow_id} is not the run's current generation`);
      newWorkflowID = runWorkflowId(run_id, generation + 1);
    }
    const application_version = opsApplicationVersion();
    let recovered_workflow_id: string;
    if (newWorkflowID) {
      await ensureRunRecoveryFork({ workflow_id: workflow_id!, successor_id: newWorkflowID,
        start_step: startStep, application_version });
      recovered_workflow_id = newWorkflowID;
    } else {
      const forked = await DBOS.forkWorkflow(workflow_id!, startStep,
        { applicationVersion: application_version,
          ...(status.workflowName === "oakridgeEffectWorkflow" && status.timeoutMS !== undefined
            ? { timeoutMS: status.timeoutMS } : {}) });
      recovered_workflow_id = forked.workflowID;
    }
    return { workflowID: recovered_workflow_id, action: "forked", startStep };
  } finally { await DBOS.shutdown(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runOps(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
