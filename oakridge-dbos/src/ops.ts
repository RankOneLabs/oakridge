import { DBOS } from "@dbos-inc/dbos-sdk";
import { migrateEmptyDatabase } from "./storage/migrate";
import { PgPostgresExecutor } from "./storage/sql-executor";
import { selectApplicationVersion } from "./workflows/engine-version";
import "./workflows/topology";

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
  DBOS.setConfig({ name: "oakridge-ops", systemDatabaseUrl: database_url, applicationVersion: selectApplicationVersion() });
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
    const last_good_step = steps.filter((step) => step.error === null).reduce((id, step) => Math.max(id, step.functionID), -1);
    const forked = await DBOS.forkWorkflow(workflow_id!, last_good_step + 1);
    return { workflowID: forked.workflowID, action: "forked", startStep: last_good_step + 1 };
  } finally { await DBOS.shutdown(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runOps(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
