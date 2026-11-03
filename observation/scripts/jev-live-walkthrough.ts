/** One real TypeSafe grade of a newly captured plan or brief criterion.
 *
 * Supply the ordered SourceEventDelivery[] recorded by the production observation
 * publisher for a new run launched from the committed development definition:
 *
 *   bun observation/scripts/jev-live-walkthrough.ts --capture observation/fixtures/oakridge/live-verification/capture.json \
 *     --question plan.criterion_traceability --estimated-cost 0.01
 *
 * OAKRIDGE_TEST_DATABASE_URL and TYPESAFE_API_KEY are prerequisites. Missing
 * prerequisites report SKIP, without fixture replay or a substitute provider.
 * This command creates and retains its own empty observation database. It never
 * connects to the deployed database, resets data, or deploys a stack. The capture
 * must include the launch and all deliveries through the criterion being graded.
 * Readback uses authenticated HTTP response bodies for every grading record.
 * Produce the capture with oakridge-dbos/scripts/live-source-run.ts; no grading record uses SQL.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { z } from "zod";
import { canonicalDigest, canonicalJson } from "canonical-json";
import { resolveLaunchableDefinition } from "../../workflow-config/src/definition-store";
import { instructionDigest } from "../src/grading/evaluator";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { workOneJob } from "../src/grading/jobs/worker";
import { createApp } from "../src/http/app";
import { decodeSourceEventDelivery, type SourceEventDelivery } from "../src/ingest/cursor";
import type { GradePage } from "../src/storage/grading-store";
import type { GradingJob } from "../src/storage/grading-job-store";
import type { ItemsPage } from "../src/storage/projection-store";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import type { SourceRevisionRead } from "../src/storage/capture-store";

type LiveQuestionId = "plan.criterion_traceability" | "brief.source_fidelity";
export interface LiveOptions { readonly capture_path: string; readonly question_id: LiveQuestionId;
  readonly estimated_cost: number; readonly report_path?: string; readonly resume_database_name?: string }
interface CapturedRun { readonly run_id: string; readonly definition_id: string;
  readonly namespace: string; readonly deliveries: readonly SourceEventDelivery[] }

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

export function missingLivePrerequisites(capture_path: string | undefined): readonly string[] {
  return [
    ...(!process.env.OAKRIDGE_TEST_DATABASE_URL ? ["OAKRIDGE_TEST_DATABASE_URL"] : []),
    ...(!process.env.TYPESAFE_API_KEY ? ["TYPESAFE_API_KEY"] : []),
    ...(!capture_path ? ["a new production capture (--capture or OAKRIDGE_LIVE_CAPTURE)"] : []),
  ];
}
function requireCondition(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
function sameJson(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left); const b = canonicalJson(right);
  return a.ok && b.ok && a.value === b.value;
}
/** pg rows use ISO Z; SQL to_jsonb uses +00:00 for the same recorded instant. */
function normalizedExecution(execution: GradePage["items"][number]["execution"]) {
  return { ...execution, started_at: new Date(execution.started_at).toISOString(),
    ended_at: execution.ended_at === null ? null : new Date(execution.ended_at).toISOString() };
}

/** Decode the producer boundary, retaining its v2 envelopes and provenance verbatim. */
async function readCapturedRun(path: string): Promise<CapturedRun> {
  const input: unknown = await Bun.file(path).json();
  requireCondition(Array.isArray(input) && input.length > 0, "capture must be a nonempty SourceEventDelivery[]");
  const deliveries = input.map((value: unknown) => {
    const decoded = decodeSourceEventDelivery(value);
    requireCondition(decoded, "invalid production source-event delivery");
    return decoded;
  });
  const launch = deliveries[0];
  requireCondition(launch?.outcome.kind === "run_input", "capture must start with this run's launch");
  requireCondition(launch.previous.commit_txid === "0" && launch.previous.id === "", "capture must start at the initial cursor");
  const definition = resolveLaunchableDefinition("development");
  requireCondition(definition.ok, "committed development definition cannot be resolved");
  const run_id = launch.outcome.run_id;
  requireCondition(run_id !== "run-38bd8c2fad299e90", "pre-cutover fixture replay is not live verification");
  requireCondition(deliveries.every(({ outcome }) => outcome.run_id === run_id
    && outcome.definition_id === definition.value.definition_id), "capture must contain one run of the current committed definition");
  const revisions = deliveries.flatMap(({ outcome }) => outcome.kind === "artifact_revision" ? [outcome.revision] : []);
  const namespace = revisions[0]?.source.namespace;
  requireCondition(namespace, "capture has no artifact revisions");
  requireCondition(revisions.every((revision) => revision.format === "observation.artifact-revision/v2"
    && revision.source.producer === "oakridge" && revision.source.namespace === namespace
    && revision.source.run_id === run_id && revision.source.definition_id === definition.value.definition_id),
  "capture revisions must retain the run's v2 provenance");
  return { run_id, definition_id: definition.value.definition_id, namespace, deliveries };
}

// These fields mirror the stored records returned by the authenticated HTTP API.
const storedGrade = z.object({
  question: z.object({ question_id: z.string(), question_version: z.string(), question_text: z.string(),
    input_recipe: z.unknown(), expected_definition_id: z.string(), expected_artifact_schema_version: z.string() }),
  evidence_set: z.object({ evidence_set_id: z.string(), is_incomplete: z.literal(false),
    evidence_refs: z.array(z.object({ ref: z.string(), content: z.unknown(), digest: z.string() })).min(2) }),
  evaluator: z.object({ evaluator_definition_id: z.string(), provider: z.literal("typesafe"), instruction_text: z.string() }),
  execution: z.object({ execution_id: z.string(), status: z.literal("completed"),
    provider_attempts: z.array(z.object({ status: z.literal("completed"), estimated_cost: z.number().positive(),
      job_id: z.string(), attempt: z.number().int().positive(), cost: z.number().nonnegative(),
      external_processing_policy: z.string().optional(), cost_overage: z.number().nonnegative().optional(),
      request_id: z.string().nullable() })).min(1),
    reproducibility_metadata: z.object({ raw_answer: z.unknown(), provider_model: z.string(),
      latency_ms: z.number().nonnegative(), runner: z.literal("jev_direct"), probability_provenance: z.literal("provider_returned") }) }),
  observation: z.object({ execution_id: z.string(), subject_occurrence_id: z.string(), answer_payload: z.unknown(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)) }),
});
export interface LiveReport { readonly database_name: string; readonly run_id: string;
  readonly execution_id: string; readonly subject_occurrence_id: string;
  readonly capture_digest: string;
  readonly question_id: LiveQuestionId; readonly raw_answer: unknown;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly records: z.infer<typeof storedGrade> }

/** Ingest a real capture, derive production evidence, call the provider, then read back. */
export async function verifyCapturedRun(options: LiveOptions): Promise<LiveReport> {
  const missing = missingLivePrerequisites(options.capture_path);
  requireCondition(missing.length === 0, `missing live prerequisites: ${missing.join(", ")}`);
  requireCondition(Number.isFinite(options.estimated_cost) && options.estimated_cost > 0, "estimated cost must be positive");
  const captured = await readCapturedRun(options.capture_path);
  const artifact = options.question_id === "plan.criterion_traceability" ? "plan" : "brief";
  const revision = captured.deliveries.flatMap(({ outcome }) => outcome.kind === "artifact_revision"
    && outcome.revision.source.artifact_kind === artifact ? [outcome.revision] : []).at(-1);
  requireCondition(revision, `capture has no ${artifact} revision`);
  const expectation = { definition_id: captured.definition_id, artifact_schema_version: revision.source.artifact_schema_version };
  const question = oakridgeQuestions({ "analysis.finding_relevance": expectation, "plan.criterion_traceability": expectation,
    "brief.source_fidelity": expectation, "assessment.coverage": expectation })[options.question_id].definition;
  const tenant = { producer: "oakridge", namespace: captured.namespace };
  const credentials = { ingest: [{ ...tenant, token: crypto.randomUUID() }], read: [{ ...tenant, token: crypto.randomUUID() }],
    grade: [{ ...tenant, token: crypto.randomUUID(), reviewer_id: "live-verifier" }] };
  const name = options.resume_database_name ?? `observation_jev_live_${randomBytes(8).toString("hex")}`;
  requireCondition(/^observation_jev_live_[0-9a-f]{16}$/.test(name), "resume requires this command's throwaway database name");
  // The URL comes only from the isolated test-server variable. Only this freshly
  // generated database is migrated; it is retained even when verification fails.
  const server_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  requireCondition(server_url, "OAKRIDGE_TEST_DATABASE_URL disappeared");
  if (!options.resume_database_name) {
    const admin = new Client({ connectionString: server_url });
    await admin.connect();
    try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  }
  const url = new URL(server_url); url.pathname = `/${name}`;
  const db = openDatabase(url.href);
  console.log(`retained verification database ${name}; run ${captured.run_id}`);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const request = async (path: string, token: string, body?: unknown): Promise<Response> => {
      const response = await app.request(path, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      requireCondition(response.ok, `${path} HTTP ${response.status}: ${response.ok ? "" : await response.text()}`);
      return response;
    };
    const ingest_token = credentials.ingest[0].token;
    const read_token = credentials.read[0].token;
    const grade_token = credentials.grade[0].token;
    if (!options.resume_database_name)
      for (const delivery of captured.deliveries) await request("/v1/sources/oakridge/events", ingest_token, delivery);
    for (const { outcome } of captured.deliveries) {
      if (outcome.kind !== "artifact_revision") continue;
      const revision = outcome.revision;
      const stored = await (await request(`/v1/source-revisions/${encodeURIComponent(revision.source.revision_id)}`, read_token)).json() as SourceRevisionRead;
      requireCondition(stored.run_id === captured.run_id && stored.definition_id === captured.definition_id
        && stored.artifact_schema_version === revision.source.artifact_schema_version
        && stored.body_digest === revision.body_digest && sameJson(stored.body, revision.body),
      "stored source revision differs from the production capture");
    }
    const items = await (await request(`/v1/runs/${encodeURIComponent(captured.run_id)}/items?limit=200`, read_token)).json() as ItemsPage;
    const candidates = items.items.filter((item) => item.item_kind === "criterion" && item.artifact_kind === artifact
      && revision.source.revision_id.endsWith(`:${item.revision_id}`) && item.producer_local_id !== null);
    requireCondition(candidates.length > 0, `capture did not project a producer-identified ${artifact} criterion`);
    const instruction_text = JSON.stringify({ system_one: { type: "choice",
      instructions: SYSTEM_ONE_INSTRUCTIONS[options.question_id], criteria: SYSTEM_ONE_CRITERIA[options.question_id] } });
    const evaluator = { evaluator_definition_id: `jev-direct-${options.question_id}`, kind: "model",
      backend_kind: "local", provider: "typesafe", model: "jev-latest", instruction_text,
      prompt_digest: instructionDigest(instruction_text), config_digest: "jev-live-2", runtime_revision: "1",
      cost_metadata: null, seed: null, attempt_controls: null };
    const subject = candidates[0];
    requireCondition(subject, "no grade subject");
    // No evidence is supplied: queue admission must derive it from this capture.
    const identity = { subject_occurrence_id: subject.occurrence_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: evaluator.evaluator_definition_id,
      config_digest: evaluator.config_digest, attempt_label: "live-1" };
    const enqueued = await (await request("/v1/evaluation-jobs", grade_token,
      { identity, context: { question, evaluator }, runner: "jev_direct", estimated_cost: options.estimated_cost })).json() as { job_id: string };
    await workOneJob(db, tenant);
    const job = await (await request(`/v1/evaluation-jobs/${enqueued.job_id}`, read_token)).json() as GradingJob;
    requireCondition(job.state === "terminal" && job.terminal_cause === null,
      `provider job ${job.job_id} ended in ${job.state}/${job.terminal_cause}`);
    const grades_path = `/v1/items/${encodeURIComponent(subject.occurrence_id)}/grades?limit=200`;
    requireCondition((await app.request(grades_path)).status === 403, "unauthenticated grade read must be refused");
    const grades = await (await request(grades_path, read_token)).json() as GradePage;
    const matching = grades.items.filter((grade) => grade.execution.question_id === identity.question_id
      && grade.execution.question_version === identity.question_version
      && grade.execution.evaluator_definition_id === identity.evaluator_definition_id
      && grade.execution.config_digest === identity.config_digest && grade.execution.attempt_label === identity.attempt_label);
    const grade = matching[0];
    requireCondition(matching.length === 1 && grade, "completed job must yield exactly one readable provider grade for its identity");
    const execution_response = await request(`/v1/evaluation-executions/${grade.execution.execution_id}`, read_token);
    const execution = await execution_response.json() as typeof grade.execution;
    requireCondition(sameJson(normalizedExecution(execution), normalizedExecution(grade.execution)),
      "execution readback differs from grade listing");
    const question_path = `/v1/questions/${encodeURIComponent(question.question_id)}/versions/${encodeURIComponent(question.question_version)}`;
    const evidence_path = `/v1/evidence-sets/${encodeURIComponent(job.evidence_set_id!)}`;
    for (const path of [question_path, evidence_path])
      requireCondition((await app.request(path)).status === 403, `${path} must refuse unauthenticated readback`);
    const record = storedGrade.parse({
      question: await (await request(question_path, read_token)).json(),
      evidence_set: await (await request(evidence_path, read_token)).json(),
      evaluator: grade.evaluator, execution, observation: grade.observation,
    });
    requireCondition(record.question.expected_definition_id === captured.definition_id
      && record.question.expected_artifact_schema_version === expectation.artifact_schema_version
      && record.question.question_id === options.question_id && record.question.question_text === question.question_text,
    "stored question differs from its captured provenance or supported question");
    requireCondition(sameJson(record.question.input_recipe, question.input_recipe)
      && record.evaluator.evaluator_definition_id === evaluator.evaluator_definition_id
      && record.evaluator.instruction_text === instruction_text, "stored question recipe or evaluator differs from admission");
    requireCondition(record.evidence_set.evidence_set_id === job.evidence_set_id
      && record.evidence_set.evidence_refs.every((ref) => ref.content !== null && ref.digest), "stored evidence is incomplete");
    requireCondition(record.execution.execution_id === grade.execution.execution_id
      && record.observation.execution_id === grade.execution.execution_id
      && record.observation.subject_occurrence_id === subject.occurrence_id, "stored grade identities disagree");
    requireCondition(record.execution.reproducibility_metadata.raw_answer !== undefined
      && Object.keys(record.observation.probabilities).length > 0, "provider raw answer or probabilities were not retained");
    const capture_digest = canonicalDigest(captured.deliveries);
    requireCondition(capture_digest.ok, "could not digest the verified production capture");
    const report: LiveReport = { database_name: name, run_id: captured.run_id, execution_id: grade.execution.execution_id,
      capture_digest: capture_digest.value,
      subject_occurrence_id: subject.occurrence_id, question_id: options.question_id,
      raw_answer: record.execution.reproducibility_metadata.raw_answer,
      probabilities: record.observation.probabilities, records: record };
    if (options.report_path) await Bun.write(options.report_path, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally { await db.destroy(); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const capture_path = argument("--capture") ?? process.env.OAKRIDGE_LIVE_CAPTURE;
  const missing = missingLivePrerequisites(capture_path);
  if (missing.length) console.warn(`SKIP: direct-provider live verification; missing ${missing.join(", ")}`);
  else {
    const question_id = argument("--question") ?? "plan.criterion_traceability";
    requireCondition(question_id === "plan.criterion_traceability" || question_id === "brief.source_fidelity", "unsupported --question");
    requireCondition(capture_path, "--capture is required");
    await verifyCapturedRun({ capture_path, question_id, estimated_cost: Number(argument("--estimated-cost") ?? "0.01"),
      report_path: argument("--report"), resume_database_name: argument("--resume-database") });
  }
}
