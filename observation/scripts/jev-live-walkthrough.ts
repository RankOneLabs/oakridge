/** One live direct-Jev grade against TypeSafe, on a captured planning-and-brief pass.
 *
 * This is the repeatable form of the walkthrough recorded in
 * `docs/observation-operations.md`. It ingests the checked-in run-slice plan and brief
 * revisions through the Oakridge source-event route, projects their criteria, then grades
 * one pinned pilot question through the durable queue and the real provider runner. The
 * grade is the only network call; everything else is local.
 *
 * It needs an isolated PostgreSQL server in `OAKRIDGE_TEST_DATABASE_URL` and a provider
 * key in `TYPESAFE_API_KEY`. It creates a throwaway database, leaves it in place so the
 * stored execution and observation can be read back, and prints its name.
 *
 *   bun scripts/jev-live-walkthrough.ts [--question brief.source_fidelity] [--estimated-cost 0.01]
 *
 * The queue admits a network grade only against a positive cost estimate, which is what it
 * reserves against the configured spend caps; TypeSafe reports no cost of its own.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { instructionDigest } from "../src/grading/evaluator";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { workOneJob } from "../src/grading/jobs/worker";
import { createApp } from "../src/http/app";
import { listRunItems } from "../src/storage/projection-store";
import { readJob } from "../src/storage/grading-job-store";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";

type LiveQuestionId = "plan.criterion_traceability" | "brief.source_fidelity";
interface Options { readonly question_id: LiveQuestionId; readonly keep_database: boolean;
  readonly estimated_cost: number }
interface EnqueuedJob { readonly job_id: string }

/** The two pilot questions whose evidence a captured planning-and-brief pass can supply. */
const SYSTEM_ONE_CRITERIA: Readonly<Record<LiveQuestionId, Readonly<Record<string, string>>>> = {
  "plan.criterion_traceability": {
    traceable: "The cited decision supports the plan criterion",
    unsupported: "The cited decision does not support the plan criterion",
    unclear_insufficient_evidence: "The captured excerpts do not settle support",
  },
  "brief.source_fidelity": {
    faithful: "The brief criterion preserves the meaning of its plan criterion",
    changed_meaning: "The brief criterion changes the meaning of its plan criterion",
    unclear_insufficient_evidence: "The captured excerpts do not settle the relationship",
  },
};
const SYSTEM_ONE_INSTRUCTIONS: Readonly<Record<LiveQuestionId, string>> = {
  "plan.criterion_traceability": "Does plan_criterion follow from its cited plan_decision? "
    + "Choose traceable when the decision supports the criterion; unsupported when it does not; "
    + "unclear_insufficient_evidence only when the present excerpts cannot settle the relationship. "
    + "Do not infer uncited sources.",
  "brief.source_fidelity": "Does brief_criterion preserve the meaning of the plan_criterion it derives from? "
    + "Choose faithful when the meaning is preserved; changed_meaning when it is not; "
    + "unclear_insufficient_evidence only when the present excerpts cannot settle the relationship. "
    + "Rewording alone is not changed_meaning.",
};

const CRITERION_LOCAL_ID = "criterion-lineage";
const DECISION_LOCAL_ID = "decision-capture";
const tenant = { producer: "oakridge", namespace: "jev-live-walkthrough" };
const credentials = {
  ingest: [{ ...tenant, token: "ingest-live" }],
  read: [{ ...tenant, token: "read-live" }],
  grade: [{ ...tenant, token: "grade-live", reviewer_id: "oakridge-operator" }],
};
const fixtureRoot = new URL("../fixtures/oakridge/run-slice/", import.meta.url);

function parseOptions(argv: readonly string[]): Options {
  const named = argv.indexOf("--question");
  const question_id = named === -1 ? "brief.source_fidelity" : argv[named + 1];
  if (question_id !== "plan.criterion_traceability" && question_id !== "brief.source_fidelity")
    throw new Error("--question must be plan.criterion_traceability or brief.source_fidelity");
  const priced = argv.indexOf("--estimated-cost");
  const estimated_cost = priced === -1 ? 0.01 : Number(argv[priced + 1]);
  if (!Number.isFinite(estimated_cost) || estimated_cost <= 0)
    throw new Error("--estimated-cost must be a positive number");
  return { question_id, keep_database: argv.includes("--keep-database"), estimated_cost };
}

function digestOf(value: JsonValue): string {
  const result = canonicalDigest(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

const readFixture = async (file: string): Promise<JsonValue> =>
  Bun.file(new URL(file, fixtureRoot)).json() as Promise<JsonValue>;

interface RevisionEvent {
  readonly id: string; readonly commit_txid: string; readonly created_at: string;
  readonly run_id: string; readonly unit_id: string;
  readonly payload: { readonly kind: string; readonly unit: string; readonly artifact: string;
    readonly body: JsonValue; readonly by: string | null; readonly predecessor: string | null;
    readonly subject: string | null };
}
interface EventFixture { readonly run_id: string; readonly rows: readonly RevisionEvent[] }

const revisionRef = (row: RevisionEvent): string => `${row.payload.unit}:${row.payload.artifact}:1`;

/** Deliver the captured revisions in their observed transaction order, as the source route requires. */
async function ingestCapturedPass(app: ReturnType<typeof createApp>, events: EventFixture): Promise<readonly RevisionEvent[]> {
  const headers = { authorization: `Bearer ${credentials.ingest[0]!.token}`, "content-type": "application/json" };
  let cursor = { commit_txid: "0", id: "" };
  const bundle = { id: "development", digest: "fixture-bundle" };
  const delivered: RevisionEvent[] = [];
  for (const row of events.rows) {
    const next = { commit_txid: row.commit_txid, id: row.id };
    const outcome = row.payload.kind === "launched"
      ? { format: "observation.source-event/v1", kind: "run_input", event_kind: "launched",
        run_id: row.run_id, event_id: row.id, definition_bundle: bundle, artifact_schema_version: null,
        input: (row.payload as unknown as { input: JsonValue }).input, input_schema_version: "development-v1" }
      : row.payload.kind === "revision_published"
        ? { format: "observation.source-event/v1", kind: "artifact_revision", event_kind: "revision_published",
          run_id: row.run_id, event_id: row.id, definition_bundle: bundle,
          artifact_schema_version: "development-v1",
          revision: { format: "observation.artifact-revision/v1",
            source: { ...tenant, revision_id: `${tenant.producer}:${tenant.namespace}:${revisionRef(row)}`,
              run_id: row.run_id, unit_id: row.unit_id, artifact_kind: row.payload.artifact,
              artifact_schema_version: "development-v1", definition_bundle: bundle,
              predecessor_id: row.payload.predecessor, subject_id: row.payload.subject, by_id: row.payload.by },
            recorded_at: row.created_at, body: row.payload.body, body_digest: digestOf(row.payload.body) } }
        : null;
    // The observed operator decision predates capture and enters through backfill, not here.
    if (!outcome) continue;
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST", headers,
      body: JSON.stringify({ previous: cursor, cursor: next, outcome }) });
    if (response.status !== 200) throw new Error(`ingest refused with HTTP ${response.status}: ${await response.text()}`);
    cursor = next;
    if (row.payload.kind === "revision_published") delivered.push(row);
  }
  return delivered;
}

interface GradeSubject {
  readonly subject_occurrence_id: string;
  readonly references: readonly { readonly ref: string; readonly kind: "public"; readonly content: JsonValue;
    readonly digest: string }[];
}

/** The pinned recipe's input and output roles, filled from the projected criteria of this pass. */
async function gradeSubject(db: Database, run_id: string, question_id: LiveQuestionId,
  revisions: readonly RevisionEvent[]): Promise<GradeSubject> {
  const page = await listRunItems(db, tenant, run_id, { limit: 200, offset: 0 });
  const revisionOf = (artifact: string): string => {
    const row = revisions.find((candidate) => candidate.payload.artifact === artifact);
    if (!row) throw new Error(`the fixture has no ${artifact} revision`);
    return revisionRef(row);
  };
  const item = (artifact: string, item_kind: string, local_id: string) => {
    const found = page.items.find((entry) => entry.revision_id === revisionOf(artifact)
      && entry.item_kind === item_kind && entry.producer_local_id === local_id);
    if (!found) throw new Error(`the projection has no ${artifact} ${item_kind} ${local_id}`);
    return found;
  };
  const reference = (ref: string, selected: { readonly selected_value: JsonValue }) =>
    ({ ref, kind: "public" as const, content: selected.selected_value, digest: digestOf(selected.selected_value) });
  const planCriterion = item("plan", "criterion", CRITERION_LOCAL_ID);
  if (question_id === "plan.criterion_traceability") {
    const decision = item("plan", "decision", DECISION_LOCAL_ID);
    return { subject_occurrence_id: planCriterion.occurrence_id,
      references: [reference("plan_criterion", planCriterion), reference("plan_decision", decision)] };
  }
  const briefCriterion = item("brief", "criterion", CRITERION_LOCAL_ID);
  return { subject_occurrence_id: briefCriterion.occurrence_id,
    references: [reference("plan_criterion", planCriterion), reference("brief_criterion", briefCriterion)] };
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required for a live grade");

  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const name = `observation_jev_live_${stamp}_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const db = openDatabase(url.href);
  console.log(`database ${name}, tenant ${tenant.producer}/${tenant.namespace}`);

  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const events = await readFixture("events.json") as unknown as EventFixture;
    const revisions = await ingestCapturedPass(app, events);
    const subject = await gradeSubject(db, events.run_id, options.question_id, revisions);

    const pilot = LANGFUSE_PILOT_QUESTIONS[options.question_id];
    const question = pilot.definition;
    const evidence = { evidence_set_id: digestOf(subject.references as unknown as JsonValue),
      references: subject.references, is_incomplete: false, incompleteness_reason: null };
    const instruction_text = JSON.stringify({ system_one: { type: "choice",
      instructions: SYSTEM_ONE_INSTRUCTIONS[options.question_id],
      criteria: SYSTEM_ONE_CRITERIA[options.question_id] } });
    const evaluator = { evaluator_definition_id: `jev-direct-${options.question_id}`, kind: "model",
      backend_kind: "local", provider: "typesafe", model: "jev-latest", instruction_text,
      prompt_digest: instructionDigest(instruction_text), config_digest: "jev-live-1", runtime_revision: "1",
      cost_metadata: null, seed: null, attempt_controls: null };
    const identity = { subject_occurrence_id: subject.subject_occurrence_id,
      evidence_set_id: evidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: evaluator.evaluator_definition_id,
      config_digest: evaluator.config_digest, attempt_label: "live-1" };

    const enqueued = await app.request("/v1/evaluation-jobs", { method: "POST",
      headers: { authorization: `Bearer ${credentials.grade[0]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ identity, context: { question, evidence, evaluator }, runner: "jev_direct",
        estimated_cost: options.estimated_cost }) });
    if (enqueued.status !== 201) throw new Error(`enqueue refused with HTTP ${enqueued.status}: ${await enqueued.text()}`);
    const enqueuedJob = await enqueued.json() as EnqueuedJob;
    console.log(`question ${question.question_id}/${question.question_version}, subject ${subject.subject_occurrence_id}`);
    console.log(`request state refs: ${subject.references.map((entry) => entry.ref).join(", ")}`);

    await workOneJob(db, tenant);
    const job = await readJob(db, tenant, enqueuedJob.job_id);
    console.log(`job ${job?.job_id ?? "none"} finished in state ${job?.state ?? "none"}`);

    const execution = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .executeTakeFirst());
    const observation = execution ? await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation")
      .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("execution_id", "=", execution.execution_id).executeTakeFirst()) : undefined;

    console.log(JSON.stringify({
      execution_id: execution?.execution_id ?? null,
      execution_status: execution?.status ?? null,
      execution_error: execution?.error ?? null,
      provider_attempts: execution?.provider_attempts ?? null,
      model_usage: execution?.model_usage ?? null,
      provider_reported_cost: execution?.cost ?? null,
      provider_request_id: execution?.external_execution_id ?? null,
      provider_link: execution?.provider_link ?? null,
      reproducibility_metadata: execution?.reproducibility_metadata ?? null,
      observation_id: observation?.observation_id ?? null,
      answer: observation?.answer_payload ?? null,
      probabilities: observation?.probabilities ?? null,
      confidence: observation?.confidence ?? null,
    }, null, 2));
    if (!options.keep_database) console.log(`\nretained database ${name}; drop it with: DROP DATABASE ${name}`);
  } finally {
    await db.destroy();
    await admin.end();
  }
}

await main();
