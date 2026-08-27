/**
 * Release a handoff stranded by a revision that landed after its downstream
 * consumer had already finished.
 *
 * When a unit emits a new revision of a handoff output, the execution
 * supersedes the old revision's waits and opens a fresh `handoff_downstream`
 * on the new one. The stage coordinator forwards `input_revised` only to a
 * consumer that is still `running` — a consumer whose execution already
 * returned is never asked to look again, and its execution workflow ID is not
 * revision-scoped, so nothing can restart it either. The new wait then has no
 * decider: no gate opens, the cohort reads `assessing` forever, and the review
 * inbox — which builds its items from open gates — shows nothing at all.
 *
 * This sends the `downstream_decision` the absent gate would have sent, so the
 * downstream wait closes and the external wait opens. It is a recovery tool for
 * a run already in that state, not a substitute for a downstream decision:
 * the operator naming `--decision-artifact` is asserting that the assessment
 * already made stands for the newer revision too.
 *
 *   bun run src/dev/release-stranded-handoff.ts \
 *     --artifact <handoff artifact revision id> \
 *     --decision-artifact <artifact id the decision was made against> \
 *     [--action approve] [--feedback "..."] --confirm
 *
 * Without `--confirm` it prints what it would send and exits.
 */
import { DBOSClient } from "@dbos-inc/dbos-sdk";

import { BUILT_IN_GATE_DISPOSITIONS, isBuiltInGateAction, selectBuiltInGateDisposition } from "../domain/gates";
import type { ArtifactId } from "../domain/primitives";
import type { HandoffCommand } from "../workflows/handoff";
import { PgPostgresExecutor } from "../storage/sql-executor";

interface Options {
  readonly artifact_id: string;
  readonly decision_artifact_id: string;
  readonly action: string;
  readonly feedback: string | null;
  readonly confirmed: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseOptions = (argv: readonly string[]): Options => {
  const flags = new Map<string, string>();
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--confirm") { confirmed = true; continue; }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument '${argument}'`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    flags.set(argument.slice(2), value);
    index += 1;
  }
  const artifactId = flags.get("artifact");
  const decisionArtifactId = flags.get("decision-artifact");
  if (!artifactId || !UUID_PATTERN.test(artifactId)) throw new Error("--artifact must be an artifact revision UUID");
  if (!decisionArtifactId || !UUID_PATTERN.test(decisionArtifactId)) throw new Error("--decision-artifact must be an artifact revision UUID");
  // The handoff reads the action through the built-in vocabulary: anything it
  // does not recognise is a non-release, which would send the producer back
  // for a revision instead of releasing it. Refuse the typo up front.
  const action = flags.get("action") ?? "approve";
  if (!isBuiltInGateAction(action)) {
    throw new Error(`--action '${action}' is not a gate action; expected one of ${Object.keys(BUILT_IN_GATE_DISPOSITIONS).join(", ")}`);
  }
  return { artifact_id: artifactId, decision_artifact_id: decisionArtifactId,
    action, feedback: flags.get("feedback") ?? null, confirmed };
};

interface ArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_key: string;
  readonly unit_id: string;
  readonly artifact_type: string;
  readonly version: number;
  readonly lifecycle_state: string;
  readonly output_name: string;
}

interface OpenWaitRow {
  readonly id: string;
  readonly command_workflow_id: string;
  readonly downstream_role: string | null;
}

/** DBOS statuses under which an execution can still decide the wait itself. */
const LIVE_DBOS_STATUSES: ReadonlySet<string> = new Set(["PENDING", "ENQUEUED", "DELAYED"]);

const databaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");

const options = parseOptions(process.argv.slice(2));
const sql = PgPostgresExecutor.connect(databaseUrl);

const describeArtifact = async (id: string): Promise<ArtifactRow | null> => {
  const rows = await sql.query<ArtifactRow>(
    `SELECT artifact.id::text, stage.run_id::text, stage.stage_key, artifact.unit_id,
            artifact.artifact_type, artifact.version, artifact.lifecycle_state, artifact.output_name
     FROM oakridge.artifact artifact
     JOIN oakridge.stage_instance stage ON stage.id = artifact.stage_instance_id
     WHERE artifact.id = $1`, [id]);
  return rows[0] ?? null;
};

const handoff = await describeArtifact(options.artifact_id);
if (!handoff) throw new Error(`artifact '${options.artifact_id}' was not found`);
const decision = await describeArtifact(options.decision_artifact_id);
if (!decision) throw new Error(`decision artifact '${options.decision_artifact_id}' was not found`);
if (decision.run_id !== handoff.run_id) throw new Error("the decision artifact belongs to a different run");
if (decision.unit_id !== handoff.unit_id) throw new Error(`the decision artifact addresses unit '${decision.unit_id}', not '${handoff.unit_id}'`);
if (handoff.lifecycle_state !== "current") throw new Error(`the handoff artifact is '${handoff.lifecycle_state}', not 'current'`);

const openWaits = await sql.query<OpenWaitRow>(
  `SELECT id::text, command_workflow_id, closes_on->>'downstream_role' AS downstream_role
   FROM oakridge.wait
   WHERE artifact_revision_id = $1 AND kind = 'handoff_downstream' AND status = 'open'`, [options.artifact_id]);
const wait = openWaits[0];
if (!wait) throw new Error(`artifact '${options.artifact_id}' has no open handoff_downstream wait; nothing is stranded`);
if (openWaits.length > 1) throw new Error(`artifact '${options.artifact_id}' has ${openWaits.length} open downstream waits; refusing to guess`);

// A wait whose consumer is still running is not stranded — it is going to be
// decided the ordinary way, and forcing it here would race that decision. The
// role names the consuming stage's `operator_role`, not its `stage_key`.
const consumerRows = await sql.query<{ readonly status: string | null; readonly execution_workflow_id: string }>(
  `SELECT status.status, projection.execution_workflow_id
   FROM oakridge.executor_projection projection
   JOIN oakridge.stage_instance stage ON stage.id = projection.stage_instance_id
   LEFT JOIN dbos.workflow_status status ON status.workflow_uuid = projection.execution_workflow_id
   WHERE stage.run_id = $1 AND stage.stage_contract->>'operator_role' = $2 AND projection.unit_id = $3`,
  [handoff.run_id, wait.downstream_role, handoff.unit_id]);
const consumer = consumerRows[0];

console.log(`run              ${handoff.run_id}`);
console.log(`cohort           ${handoff.unit_id}`);
console.log(`handoff artifact ${handoff.artifact_type} v${handoff.version} (${handoff.output_name}) ${handoff.id}`);
console.log(`decision stands  ${decision.artifact_type} v${decision.version} ${decision.id}`);
console.log(`open wait        ${wait.id} -> ${wait.command_workflow_id}`);
console.log(`downstream role  ${wait.downstream_role ?? "(none)"}${consumer ? ` — execution ${consumer.status ?? "unknown"}` : " — no execution recorded"}`);
console.log(`command          downstream_decision action='${options.action}' (${selectBuiltInGateDisposition(options.action)}) feedback=${options.feedback === null ? "null" : `'${options.feedback}'`}`);

if (consumer && consumer.status !== null && LIVE_DBOS_STATUSES.has(consumer.status)) {
  throw new Error(`the '${wait.downstream_role}' execution for this cohort is still ${consumer.status}; it can still decide this wait itself`);
}
if (!options.confirmed) {
  console.log("\ndry run — pass --confirm to send");
  await sql.close();
  process.exit(0);
}

const command: HandoffCommand = { kind: "downstream_decision", action: options.action,
  decision_artifact_id: options.decision_artifact_id as ArtifactId, feedback: options.feedback };
// Deterministic, so re-running after a partial failure cannot decide twice.
const idempotencyKey = `stranded-handoff:${wait.command_workflow_id}:${options.decision_artifact_id}:${options.action}`;

const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
await client.send(wait.command_workflow_id, command, "handoff-command", idempotencyKey);
await client.destroy();
await sql.close();
console.log(`\nsent — idempotency key ${idempotencyKey}`);
