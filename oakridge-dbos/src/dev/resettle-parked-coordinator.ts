/**
 * Rewinds a stage coordinator that parked a unit it should have released, so
 * that a backend running the settle-from-record code decides it again.
 *
 * Why this exists: a coordinator settles a unit inline, in workflow code, and
 * DBOS replays that code against the steps it recorded. A coordinator that
 * read a watchdog verdict ahead of the contract recorded a `setEvent` (the
 * rerun state) at the position where the fixed code records the next unit's
 * launch, and DBOS refuses the mismatch on replay: the coordinator errors, its
 * relay reports the stage failed, and the run is torn down. Forking would copy
 * the same steps under a new workflow ID, and every other participant — the
 * run, the relays, the operator surface — addresses the coordinator by the ID
 * it has. So the recorded steps from the settlement onward are removed in
 * place, which is what `forkWorkflow` does without the rename, and the attempt
 * is adopted by the application version that will run it.
 *
 * Usage, with the backend stopped:
 *
 *   DBOS_SYSTEM_DATABASE_URL=postgres://... bun run src/dev/resettle-parked-coordinator.ts \
 *     --coordinator <stage coordinator workflow id> \
 *     --from-step <first recorded step to remove> \
 *     --application-version <sha the backend will start with> \
 *     [--drop-event <workflow event key>]... [--confirm]
 *
 * Without `--confirm` it prints what it would do and changes nothing.
 */
import { PgPostgresExecutor } from "../storage/sql-executor";

interface Options {
  readonly coordinator: string;
  readonly from_step: number;
  readonly application_version: string;
  readonly drop_events: readonly string[];
  readonly confirmed: boolean;
}

const parseOptions = (argv: readonly string[]): Options => {
  const flags = new Map<string, string>();
  const dropEvents: string[] = [];
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--confirm") { confirmed = true; continue; }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument '${argument}'`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--drop-event") dropEvents.push(value);
    else flags.set(argument.slice(2), value);
    index += 1;
  }
  const coordinator = flags.get("coordinator");
  if (!coordinator || !coordinator.includes(":stage:")) throw new Error("--coordinator must be a stage coordinator workflow id (…:attempt:<attempt>:stage:<key>)");
  const fromStep = Number(flags.get("from-step"));
  if (!Number.isInteger(fromStep) || fromStep < 1) throw new Error("--from-step must be a positive integer: the first recorded step to remove");
  const applicationVersion = flags.get("application-version");
  if (!applicationVersion || !/^[0-9a-f]{7,40}$/.test(applicationVersion)) throw new Error("--application-version must be the git SHA the backend will start with");
  return { coordinator, from_step: fromStep, application_version: applicationVersion, drop_events: dropEvents, confirmed };
};

const attemptRootOf = (coordinator: string): string => coordinator.slice(0, coordinator.indexOf(":stage:"));

const options = parseOptions(process.argv.slice(2));
const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
const backendUrl = process.env.OAKRIDGE_BASE_URL ?? "http://127.0.0.1:8790";
const sql = PgPostgresExecutor.connect(databaseUrl);

interface WorkflowRow { readonly workflow_uuid: string; readonly name: string; readonly status: string; readonly application_version: string | null }
interface StepRow { readonly function_id: number; readonly function_name: string; readonly child_workflow_id: string | null }

const [coordinator] = await sql.query<WorkflowRow>(
  "SELECT workflow_uuid, name, status, application_version FROM dbos.workflow_status WHERE workflow_uuid = $1", [options.coordinator]);
if (!coordinator) throw new Error(`workflow '${options.coordinator}' does not exist`);
if (coordinator.name !== "oakridgeProductionStageWorkflow") throw new Error(`'${options.coordinator}' is a ${coordinator.name}, not a stage coordinator`);
if (coordinator.status !== "PENDING") throw new Error(`coordinator is ${coordinator.status}; only a PENDING coordinator can be rewound`);

const steps = await sql.query<StepRow>(
  "SELECT function_id, function_name, child_workflow_id FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id", [options.coordinator]);
const kept = steps.filter((step) => step.function_id < options.from_step);
const removed = steps.filter((step) => step.function_id >= options.from_step);
const boundary = kept[kept.length - 1];
if (!boundary) throw new Error(`nothing is recorded before step ${options.from_step}; there is no settlement to rewind to`);
// A recorded child is a workflow that was started (a `getResult` row names the
// workflow it read from as a child too, and reads nothing on replay). Replay
// would start it again under the same deterministic id and attach, but a tail
// with a start in it is not the settlement this exists to remove — refuse
// rather than guess.
const startedChildren = removed.filter((step) => step.child_workflow_id !== null && step.function_name !== "DBOS.getResult");
if (startedChildren.length > 0) {
  throw new Error(`steps from ${options.from_step} include started workflows (${startedChildren.map((step) => `${step.function_id}:${step.child_workflow_id}`).join(", ")}); that is not a settlement tail`);
}

const attemptRoot = attemptRootOf(options.coordinator);
const adopting = await sql.query<WorkflowRow>(
  "SELECT workflow_uuid, name, status, application_version FROM dbos.workflow_status WHERE workflow_uuid LIKE $1 AND status = 'PENDING' ORDER BY created_at",
  [`${attemptRoot}%`]);
const events = await sql.query<{ readonly key: string }>(
  "SELECT key FROM dbos.workflow_events WHERE workflow_uuid = $1 AND key = ANY($2::text[])", [options.coordinator, options.drop_events]);
const missingEvents = options.drop_events.filter((key) => !events.some((event) => event.key === key));

console.log(`coordinator      ${options.coordinator}`);
console.log(`status           ${coordinator.status} on application version ${coordinator.application_version ?? "(none)"}`);
console.log(`kept through     step ${boundary.function_id} (${boundary.function_name})`);
console.log(`removing         ${removed.length} recorded step(s):`);
for (const step of removed) console.log(`                   ${step.function_id} ${step.function_name}`);
console.log(`dropping events  ${events.length === 0 ? "(none)" : events.map((event) => event.key).join(", ")}${missingEvents.length > 0 ? ` — not recorded: ${missingEvents.join(", ")}` : ""}`);
console.log(`adopting         ${adopting.length} pending workflow(s) under ${attemptRoot} onto ${options.application_version}:`);
for (const workflow of adopting) console.log(`                   ${workflow.workflow_uuid.slice(attemptRoot.length) || "(attempt root)"} ${workflow.name} (from ${workflow.application_version ?? "(none)"})`);

if (!options.confirmed) {
  console.log("dry run — pass --confirm to apply");
  await sql.close();
  process.exit(0);
}

// A running executor holds these workflows in memory and would write over
// what this rewinds; it must be stopped, and this is the only check that can
// tell whether it has been.
const backendAnswered = await fetch(`${backendUrl}/gates`, { signal: AbortSignal.timeout(1_500) }).then(() => true, () => false);
if (backendAnswered) throw new Error(`the backend is still answering at ${backendUrl}; stop it before rewinding`);

await sql.transaction(async (transaction) => {
  await transaction.query("DELETE FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_id >= $2", [options.coordinator, options.from_step]);
  if (options.drop_events.length > 0) {
    await transaction.query("DELETE FROM dbos.workflow_events WHERE workflow_uuid = $1 AND key = ANY($2::text[])", [options.coordinator, options.drop_events]);
  }
  await transaction.query(
    "UPDATE dbos.workflow_status SET application_version = $2 WHERE workflow_uuid LIKE $1 AND status = 'PENDING'",
    [`${attemptRoot}%`, options.application_version]);
});
console.log(`applied: ${removed.length} step(s) removed, ${events.length} event(s) dropped, ${adopting.length} workflow(s) adopted onto ${options.application_version}`);
await sql.close();
