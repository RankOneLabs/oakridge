import { DBOS } from "@dbos-inc/dbos-sdk";
import { migrateEmptyDatabase } from "./storage/migrate";
import { claimRunGeneration, currentRunGeneration } from "./storage/run-lifecycle";
import { PgPostgresExecutor } from "./storage/sql-executor";
import { selectApplicationVersion } from "./workflows/engine-version";
import { DEFAULT_WORKFLOW_TIMING, ensureRunRecoveryFork, forkStartStep, runWorkflowId } from "./workflows/topology";

type OpsCommand = readonly ["workflows", "list" | "inspect" | "recover", ...string[]] | readonly ["migrate"];

export async function runOps(args: readonly string[], database_url: string | undefined = process.env.DBOS_SYSTEM_DATABASE_URL): Promise<unknown> {
  const command = (args[0] === "--" ? args.slice(1) : args) as OpsCommand;
  if (!database_url) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
  if (command[0] === "migrate") {
    const db = PgPostgresExecutor.connect(database_url);
    try { await migrateEmptyDatabase(db); return { migrated: true }; }
    finally { await db.close(); }
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
    let runGeneration: { readonly run_id: string; readonly generation: number } | null = null;
    if (status.workflowName === "oakridgeRunWorkflow") {
      if (typeof status.input?.[0] !== "string") throw new Error(`run workflow ${workflow_id} has no run identity`);
      const run_id = status.input[0];
      const db = PgPostgresExecutor.connect(database_url);
      try {
        const generation = await currentRunGeneration(db, run_id);
        if (generation === null || runWorkflowId(run_id, generation) !== workflow_id)
          throw new Error(`run workflow ${workflow_id} is not the current authority generation`);
        newWorkflowID = runWorkflowId(run_id, generation + 1);
        runGeneration = { run_id, generation };
      } finally { await db.close(); }
    }
    const application_version = selectApplicationVersion();
    let recovered_workflow_id: string;
    if (newWorkflowID) {
      await ensureRunRecoveryFork({ workflow_id: workflow_id!, successor_id: newWorkflowID,
        start_step: startStep, application_version });
      recovered_workflow_id = newWorkflowID;
    } else {
      const forked = await DBOS.forkWorkflow(workflow_id!, startStep,
        { applicationVersion: application_version,
          ...(status.workflowName === "oakridgeEffectWorkflow"
            ? { timeoutMS: status.timeoutMS ?? DEFAULT_WORKFLOW_TIMING.execution_deadline_ms } : {}) });
      recovered_workflow_id = forked.workflowID;
    }
    if (runGeneration) {
      const db = PgPostgresExecutor.connect(database_url);
      try {
        if (await claimRunGeneration(db, runGeneration.run_id, runGeneration.generation) === null) {
          const generation = await currentRunGeneration(db, runGeneration.run_id);
          if (generation === null || generation <= runGeneration.generation)
            throw new Error(`run ${runGeneration.run_id} generation changed during recovery`);
        }
      } finally { await db.close(); }
    }
    return { workflowID: recovered_workflow_id, action: "forked", startStep };
  } finally { await DBOS.shutdown(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runOps(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
