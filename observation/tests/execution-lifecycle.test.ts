import { afterEach, beforeEach, expect } from "bun:test";
import { sql } from "kysely";
import { Client } from "pg";
import { err, ok } from "../src/domain/primitives";
import { parseGraderConfiguration, planRegistration, type GradingRegistration } from "../src/grading/configuration";
import type { ExecutionClaim } from "../src/grading/execution";
import type { GradingContext, RunnerResult } from "../src/grading/runner";
import { gradeNext, type GradingWorkerDependencies } from "../src/grading/worker";
import { createApp } from "../src/http/app";
import type { RepositoryReader } from "../src/ports/artifact-source";
import type { GradeRunner } from "../src/ports/grade-runner";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID } from "../src/producers/oakridge/questions";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { withTenant, type Database } from "../src/storage/database";
import { createEvidenceReconciler, type EvidenceReconciler } from "../src/storage/evidence-pipeline";
import { claimNext, completeExecution, failExecution, markRequestSent, readItemMeasurements, readRunSpend } from "../src/storage/execution-store";
import { registerDefinitions } from "../src/storage/grading-store";
import { committedGraders, createFeed, databaseUrl, DEFINITION_ID, fixtureBody, integration, runConfig, SCHEMA_VERSION, scratchDatabase, tenant,
  type Feed } from "./grading-fixture";

const HEAD = "1111111111111111111111111111111111111111";
const LAUNCH = { spec: "The whole captured spec", repositories: [{ key: "oakridge", preparation: { repository_path: "/repos/oakridge" } }] };
const repository: RepositoryReader = {
  hasCommit: async (path, commit) => path === "/repos/oakridge" && commit === HEAD,
  readFile: async () => ({ state: "present", content: "one\ntwo\nthree" }),
};

/** Every request leaving this process. The lifecycle may reach no service but the injected runner:
 * nothing it does can write an Oakridge authority record. */
const realFetch = globalThis.fetch;
let outbound = 0;
beforeEach(() => { outbound = 0; globalThis.fetch = (async () => { outbound++; throw new Error("no outbound request is allowed"); }) as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

interface Requests { readonly sent: string[] }
type Script = (context: GradingContext, request_number: number) => RunnerResult;
/** A runner at the ordinary provider boundary: it asks to send, counts the request, and answers by script. */
function scriptedRunner(script: Script, requests: Requests, during?: () => Promise<void>): GradeRunner {
  return { kind: "model", async run(context, onRequest) {
    if (onRequest && !await onRequest()) return err({ operation: "test", entity_id: "", detail: "claim lost", category: "invalid_request" });
    requests.sent.push(`${context.question.question_id}:${context.evidence.evidence_set_id}`);
    await during?.();
    return script(context, requests.sent.length);
  } };
}
const answer = (value: string): RunnerResult => ok({ answer: { state: "answered", kind: "choice", value }, confidence: 0.9,
  probabilities: { [value]: 0.9 }, external_execution_id: null });
/** The first allowed value: relevant, supported or supports. */
const firstAllowed: Script = (context) => answer(String(context.question.allowed_values?.[0]));

interface Lifecycle {
  readonly db: Database;
  readonly feed: Feed;
  readonly registration: GradingRegistration;
  readonly reconciler: EvidenceReconciler;
  readonly requests: Requests;
  worker(script: Script, overrides?: Partial<GradingWorkerDependencies> & { readonly lease_owner?: string }): GradingWorkerDependencies & { readonly lease_owner: string };
  /** Grades until nothing is due; returns how many passes did work. */
  drain(deps: GradingWorkerDependencies & { readonly lease_owner: string }): Promise<number>;
  counts(): Promise<Record<string, number>>;
}

async function lifecycle(db: Database, retry_limit = 3): Promise<Lifecycle> {
  const parsed = parseGraderConfiguration(await committedGraders());
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const planned = planRegistration(parsed.value, oakridgeProfile.questions);
  if (!planned.ok) throw new Error(planned.error.detail);
  const registered = await registerDefinitions(db, tenant, planned.value);
  if (!registered.ok) throw new Error(registered.error.detail);
  const requests: Requests = { sent: [] };
  const silent = () => undefined;
  return {
    db, registration: planned.value, requests, feed: createFeed(db, tenant, planned.value.capture),
    reconciler: createEvidenceReconciler({ db, collector: oakridgeProfile.evidence, repository, admission: { retry_limit }, log: silent }),
    worker: (script, overrides = {}) => ({ db, tenants: [tenant], log: silent, lease_owner: "worker-a",
      controls: { run_spend: 5, retry_limit, provider_deadline_ms: 30_000, lease_ms: 60_000 },
      runners: () => scriptedRunner(script, requests), ...overrides }),
    async drain(deps) {
      let passes = 0;
      while ((await gradeNext(deps, tenant)).kind !== "idle") passes++;
      return passes;
    },
    counts: () => withTenant(db, tenant, async (trx) => (await sql<Record<string, number>>`SELECT
      (SELECT count(*)::integer FROM observation.evidence_set WHERE readiness = 'ready') AS ready,
      (SELECT count(*)::integer FROM observation.evaluation_execution) AS executions,
      (SELECT count(*)::integer FROM observation.evaluation_execution WHERE status = 'completed') AS completed,
      (SELECT count(*)::integer FROM observation.grading_provider_attempt) AS attempts,
      (SELECT count(*)::integer FROM observation.grading_provider_attempt WHERE request_sent) AS sent,
      (SELECT count(*)::integer FROM observation.grade_observation) AS answers`.execute(trx)).rows[0]!),
  };
}

async function captureAnalysis(life: Lifecycle, grading_enabled: boolean, run_id = "run-1"): Promise<void> {
  await life.feed.launch(LAUNCH, run_id, runConfig(grading_enabled));
  await life.feed.revision({ revision_id: `${run_id}-analysis`, artifact_kind: "analysis", run_id, body: await fixtureBody("analysis") });
  await life.reconciler.reconcileRun(tenant, run_id);
}
async function captureAssessment(life: Lifecycle, input: { readonly run_id?: string; readonly subject_id?: string } = {}): Promise<void> {
  const run_id = input.run_id ?? "run-1";
  await life.feed.revision({ revision_id: `${run_id}-assessment`, artifact_kind: "assessment", run_id, subject_id: input.subject_id,
    body: await fixtureBody("assessment") });
  await life.reconciler.reconcileRun(tenant, run_id);
}
const occurrenceAt = async (db: Database, revision_id: string, path: string): Promise<string> =>
  (await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("occurrence_id")
    .where("revision_id", "=", revision_id).where("json_pointer", "=", path).executeTakeFirstOrThrow())).occurrence_id;
const executionsOf = (db: Database) => withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution as x")
  .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "x.producer").onRef("i.namespace", "=", "x.namespace")
    .onRef("i.occurrence_id", "=", "x.subject_occurrence_id"))
  .select(["x.execution_id", "x.question_id", "x.status", "x.attempts", "x.retries", "x.terminal_cause", "x.evaluator_definition_id",
    "i.item_kind", "i.json_pointer", "i.revision_id"]).orderBy("x.execution_id").execute());
const attemptsOf = (db: Database, execution_id: string) => withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_provider_attempt")
  .select(["attempt", "request_sent", "outcome", "failure_category", "charged_cost", "admitted_estimate"])
  .where("execution_id", "=", execution_id).orderBy("attempt").execute());

integration("an enabled run's unlinked analysis is admitted and answered before it has any task", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const executions = await executionsOf(db);
  // One finding, one question, one pinned machine evaluator; no task exists anywhere in the run.
  expect(executions.map((row) => [row.item_kind, row.question_id, row.status])).toEqual([["finding", RELEVANCE_ID, "queued"]]);
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.logical_item").select("scope").where("scope", "=", "task").execute())).toEqual([]);
  await life.drain(life.worker(firstAllowed));
  const measured = await readItemMeasurements(db, tenant, await occurrenceAt(db, "run-1-analysis", "/findings/0"));
  expect(measured?.questions.map((entry) => [entry.evidence.question_id, entry.is_human_ready, entry.machine.map((machine) => machine.measurement)])).toEqual([
    [RELEVANCE_ID, true, [expect.objectContaining({ state: "answered", answer: { state: "answered", kind: "choice", value: "relevant" } })]]]);
  expect(await life.counts()).toMatchObject({ executions: 1, completed: 1, attempts: 1, sent: 1, answers: 1 });
  expect(outbound).toBe(0);
  // The spend read serves the exact config the launch delivered.
  expect((await readRunSpend(db, tenant, "run-1")).captured_config).toEqual(runConfig(true));
}));

integration("with grading off, every supported question still gets frozen human-ready evidence and nothing is sent", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, false);
  await captureAssessment(life);
  expect(await life.reconciler.reconcileAll(tenant)).toEqual([]);
  expect(await life.drain(life.worker(firstAllowed))).toBe(0);
  const measured = await readItemMeasurements(db, tenant, await occurrenceAt(db, "run-1-assessment", "/findings/1"));
  expect(measured?.questions.map((entry) => [entry.evidence.question_id, entry.is_human_ready, entry.machine.map((machine) => machine.measurement.state)]))
    .toEqual([[CORRECTNESS_ID, true, ["grading_off"]], [EVIDENCE_SUPPORT_ID, true, ["grading_off"]]]);
  expect(await life.counts()).toMatchObject({ ready: 9, executions: 0, attempts: 0, answers: 0 });
  expect(life.requests.sent).toEqual([]);
}));

integration("a launch that carried no config has grading off", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await life.feed.launch(LAUNCH, "run-1", null);
  await captureAssessment(life);
  expect(await life.counts()).toMatchObject({ ready: 8, executions: 0 });
  expect(await readRunSpend(db, tenant, "run-1")).toMatchObject({ is_grading_enabled: false, captured_config: null });
}));

integration("only supported kinds are admitted: tasks, risks, decisions and whole artifacts get no execution", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  await life.feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  await captureAssessment(life);
  const kinds = [...new Set((await executionsOf(db)).map((row) => row.item_kind))].sort();
  expect(kinds).toEqual(["assessment_finding", "finding"]);
  // 1 Relevance + 4 assessment findings x (Correctness, Evidence support), one machine evaluator each.
  expect((await executionsOf(db)).length).toBe(9);
}));

integration("Correctness waits for its subject build while Evidence support of the same finding is admitted", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await life.feed.launch(LAUNCH, "run-1", runConfig(true));
  await captureAssessment(life, { subject_id: "build-1" });
  const uncited = await occurrenceAt(db, "run-1-assessment", "/findings/1");
  const before = await readItemMeasurements(db, tenant, uncited);
  expect(before?.questions.map((entry) => [entry.evidence.question_id, entry.machine[0]?.measurement])).toEqual([
    [CORRECTNESS_ID, expect.objectContaining({ state: "not_ready", code: "build_result_unavailable" })],
    [EVIDENCE_SUPPORT_ID, { state: "pending", status: "queued" }]]);
  expect(new Set((await executionsOf(db)).map((row) => row.question_id))).toEqual(new Set([EVIDENCE_SUPPORT_ID]));
  await life.feed.revision({ revision_id: "build-1", artifact_kind: "build_result", body: await fixtureBody("build-result") });
  await life.reconciler.reconcileRun(tenant, "run-1");
  const after = await readItemMeasurements(db, tenant, uncited);
  expect(after?.questions.map((entry) => entry.machine[0]?.measurement.state)).toEqual(["pending", "pending"]);
}));

integration("an integration assessment with no subject, empty citations and unresolved tasks is admitted", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await life.feed.launch(LAUNCH, "run-1", runConfig(true));
  await captureAssessment(life);
  const rows = await executionsOf(db);
  // /findings/2 has no task and no citation; /findings/3 names a task the run never captured.
  for (const path of ["/findings/2", "/findings/3"])
    expect(rows.filter((row) => row.json_pointer === path).map((row) => row.question_id).sort()).toEqual([CORRECTNESS_ID, EVIDENCE_SUPPORT_ID].sort());
}));

integration("repeated reconciliation, source replay and restart add no execution and resend nothing completed", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  await captureAssessment(life);
  const admitted = await executionsOf(db);
  await life.reconciler.reconcileRun(tenant, "run-1");
  await life.feed.revision({ revision_id: "run-1-assessment", artifact_kind: "assessment", body: await fixtureBody("assessment") });
  const restarted = createEvidenceReconciler({ db, collector: oakridgeProfile.evidence, repository, admission: { retry_limit: 3 }, log: () => undefined });
  await restarted.reconcileAll(tenant);
  expect((await executionsOf(db)).map((row) => row.execution_id)).toEqual(admitted.map((row) => row.execution_id));
  await life.drain(life.worker(firstAllowed));
  const sent = life.requests.sent.length;
  await restarted.reconcileAll(tenant);
  await restarted.reconcileRun(tenant, "run-1");
  expect(await life.drain(life.worker(firstAllowed, { lease_owner: "worker-restarted" }))).toBe(0);
  expect([life.requests.sent.length, (await life.counts()).answers]).toEqual([sent, admitted.length]);
}));

integration("the claim commits before the provider is called, and no transaction is open during the request", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const observer = new Client({ connectionString: await databaseUrl(db) });
  await observer.connect();
  const seen: unknown[] = [];
  try {
    const during = async () => {
      const open = await observer.query(`SELECT count(*)::integer AS open FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`);
      await observer.query("BEGIN");
      await observer.query("SELECT set_config('observation.producer', $1, true), set_config('observation.namespace', $2, true)", [tenant.producer, tenant.namespace]);
      const claimed = await observer.query("SELECT status, attempts FROM observation.evaluation_execution");
      await observer.query("COMMIT");
      seen.push(open.rows[0].open, claimed.rows);
    };
    const deps = life.worker(firstAllowed, { runners: () => scriptedRunner(firstAllowed, life.requests, during) });
    await gradeNext(deps, tenant);
  } finally { await observer.end(); }
  expect(seen).toEqual([0, [{ status: "claimed", attempts: 1 }]]);
}));

integration("a valid answer completes with its observation in one transaction; a failed append leaves neither", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const claimed = await claimNext(db, tenant, { lease_owner: "a", lease_ms: 60_000, run_spend: 5 });
  if (claimed.kind !== "claimed") throw new Error(claimed.kind);
  // A confidence above 1 passes the answer check but the observation row refuses it.
  const refused = await completeExecution(db, tenant, claimed.claim, { answer: { state: "answered", kind: "choice", value: "irrelevant" }, confidence: 2 });
  expect(refused.ok).toBe(false);
  expect(await life.counts()).toMatchObject({ completed: 0, answers: 0 });
  expect((await executionsOf(db))[0]?.status).toBe("claimed");
  const completed = await completeExecution(db, tenant, claimed.claim, { answer: { state: "answered", kind: "choice", value: "irrelevant" }, confidence: 0.5 });
  expect(completed.ok && completed.value.kind).toBe("completed");
  expect(await life.counts()).toMatchObject({ completed: 1, answers: 1 });
}));

integration("negative and unclear answers are valid completed answers", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await life.feed.launch(LAUNCH, "run-1", runConfig(true));
  await captureAssessment(life);
  const negative: Record<string, string> = { [CORRECTNESS_ID]: "contradicted", [EVIDENCE_SUPPORT_ID]: "unclear" };
  await life.drain(life.worker((context) => answer(negative[context.question.question_id] ?? "unclear")));
  const answers = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation").select("answer_payload").execute());
  expect(new Set(answers.map((row) => (row.answer_payload as { value: string }).value))).toEqual(new Set(["contradicted", "unclear"]));
  expect(await life.counts()).toMatchObject({ executions: 8, completed: 8, answers: 8 });
}));

integration("an answer outside the pinned choices is retried and exhaustion ends failed with no grade", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db, 2);
  await captureAnalysis(life, true);
  await life.drain(life.worker(() => answer("maybe")));
  const [execution] = await executionsOf(db);
  expect([execution?.status, execution?.terminal_cause, execution?.retries]).toEqual(["failed", "invalid_outcome", 2]);
  expect((await attemptsOf(db, execution!.execution_id)).map((row) => [row.attempt, row.request_sent, row.outcome, row.failure_category]))
    .toEqual([[1, true, "failed", "invalid_answer"], [2, true, "failed", "invalid_answer"], [3, true, "failed", "invalid_answer"]]);
  expect(await life.counts()).toMatchObject({ answers: 0, sent: 3 });
}));

integration("a retryable provider failure is retried and then answered, keeping every real request", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  await life.drain(life.worker((context, request) => request === 1
    ? err({ operation: "test", entity_id: "", detail: "provider HTTP 503", category: "http_error", external_execution_id: "req-1" })
    : firstAllowed(context, request)));
  const [execution] = await executionsOf(db);
  expect([execution?.status, execution?.retries]).toEqual(["completed", 1]);
  expect((await attemptsOf(db, execution!.execution_id)).map((row) => [row.request_sent, row.outcome, row.failure_category]))
    .toEqual([[true, "failed", "http_error"], [true, "completed", null]]);
}));

integration("retries exhausted by provider failures end failed with no grade", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db, 1);
  await captureAnalysis(life, true);
  await life.drain(life.worker(() => err({ operation: "test", entity_id: "", detail: "timeout", category: "timeout" })));
  const [execution] = await executionsOf(db);
  expect([execution?.status, execution?.terminal_cause, life.requests.sent.length]).toEqual(["failed", "retry_exhausted", 2]);
  const measured = await readItemMeasurements(db, tenant, await occurrenceAt(db, "run-1-analysis", "/findings/0"));
  expect(measured?.questions[0]?.machine[0]?.measurement).toMatchObject({ state: "failed", terminal_cause: "retry_exhausted" });
  expect(await life.counts()).toMatchObject({ answers: 0 });
}));

integration("a failure before any request fails at once, sends nothing and charges nothing", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const unconfigured: GradeRunner = { kind: "model", run: async () => err({ operation: "test", entity_id: "", detail: "provider credential is not configured",
    category: "unconfigured_credential" }) };
  await life.drain(life.worker(firstAllowed, { runners: () => unconfigured }));
  const [execution] = await executionsOf(db);
  expect([execution?.status, execution?.terminal_cause]).toEqual(["failed", "runner_failed"]);
  expect(await attemptsOf(db, execution!.execution_id)).toEqual([{ attempt: 1, request_sent: false, outcome: "failed",
    failure_category: "unconfigured_credential", charged_cost: 0, admitted_estimate: 0.01 }]);
  expect((await readRunSpend(db, tenant, "run-1")).committed).toBe(0);
}));

integration("an expired claim cannot send or settle, before or after another worker reclaims it", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const first = await claimNext(db, tenant, { lease_owner: "a", lease_ms: 50, run_spend: 5 });
  if (first.kind !== "claimed") throw new Error(first.kind);
  await Bun.sleep(120);
  const outcome = { answer: { state: "answered", kind: "choice", value: "relevant" } } as const;
  expect(await markRequestSent(db, tenant, first.claim)).toBe(false);
  expect(await completeExecution(db, tenant, first.claim, outcome)).toEqual(ok({ kind: "stale_claim", execution_id: first.claim.execution_id }));
  const second = await claimNext(db, tenant, { lease_owner: "b", lease_ms: 60_000, run_spend: 5 });
  if (second.kind !== "claimed") throw new Error(second.kind);
  expect(second.claim.claim_attempt).toBe(2);
  expect(await completeExecution(db, tenant, first.claim, outcome)).toEqual(ok({ kind: "stale_claim", execution_id: first.claim.execution_id }));
  expect(await failExecution(db, tenant, first.claim, { category: "timeout", detail: "late", provider_request_id: null, provider_cost: null }))
    .toEqual(ok({ kind: "stale_claim", execution_id: first.claim.execution_id }));
  // The same owner holding an older claim attempt is refused just the same.
  const oldAttempt: ExecutionClaim = { ...second.claim, claim_attempt: 1 };
  expect(await completeExecution(db, tenant, oldAttempt, outcome)).toEqual(ok({ kind: "stale_claim", execution_id: first.claim.execution_id }));
  expect((await completeExecution(db, tenant, second.claim, outcome)).ok).toBe(true);
  expect(await life.counts()).toMatchObject({ completed: 1, answers: 1 });
  expect((await attemptsOf(db, first.claim.execution_id)).map((row) => [row.attempt, row.request_sent, row.outcome, row.failure_category]))
    .toEqual([[1, false, "failed", "lease_expired"], [2, false, "completed", null]]);
}));

integration("a claim that was current when it asked but expired while waiting on the row lock sends and writes nothing", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const claimed = await claimNext(db, tenant, { lease_owner: "a", lease_ms: 1_500, run_spend: 5 });
  if (claimed.kind !== "claimed") throw new Error(claimed.kind);
  const holder = new Client({ connectionString: await databaseUrl(db) });
  await holder.connect();
  const outcome = { answer: { state: "answered", kind: "choice", value: "relevant" } } as const;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT set_config('observation.producer', $1, true), set_config('observation.namespace', $2, true)", [tenant.producer, tenant.namespace]);
    await holder.query("SELECT 1 FROM observation.evaluation_execution WHERE execution_id = $1 FOR UPDATE", [claimed.claim.execution_id]);
    // Each write asks while the lease is still valid, then waits on the lock past the lease's end.
    const pending = Promise.all([markRequestSent(db, tenant, claimed.claim), completeExecution(db, tenant, claimed.claim, outcome),
      failExecution(db, tenant, claimed.claim, { category: "timeout", detail: "late", provider_request_id: null, provider_cost: null })]);
    for (let waiting = 0; waiting < 3;) {
      await Bun.sleep(20);
      waiting = (await holder.query(`SELECT count(*)::integer AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].waiting;
    }
    const lease_remaining = new Date(claimed.claim.lease_expires_at).getTime() - Date.now();
    expect(lease_remaining).toBeGreaterThan(0);
    await Bun.sleep(lease_remaining + 200);
    await holder.query("COMMIT");
    const stale = ok({ kind: "stale_claim" as const, execution_id: claimed.claim.execution_id });
    expect(await pending).toEqual([false, stale, stale]);
  } finally { await holder.end(); }
  expect((await executionsOf(db)).map((row) => [row.status, row.retries])).toEqual([["claimed", 0]]);
  expect((await attemptsOf(db, claimed.claim.execution_id)).map((row) => [row.request_sent, row.outcome, row.charged_cost])).toEqual([[false, null, 0]]);
  expect(await life.counts()).toMatchObject({ completed: 0, sent: 0, answers: 0 });
}));

integration("a reclaimed claim that sent a request keeps its charge and counts as a retry",async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  const first = await claimNext(db, tenant, { lease_owner: "a", lease_ms: 50, run_spend: 5 });
  if (first.kind !== "claimed") throw new Error(first.kind);
  expect(await markRequestSent(db, tenant, first.claim)).toBe(true);
  // A repeated mark charges nothing more.
  expect(await markRequestSent(db, tenant, first.claim)).toBe(false);
  await Bun.sleep(120);
  const second = await claimNext(db, tenant, { lease_owner: "b", lease_ms: 60_000, run_spend: 5 });
  if (second.kind !== "claimed") throw new Error(second.kind);
  expect((await executionsOf(db))[0]?.retries).toBe(1);
  expect((await attemptsOf(db, first.claim.execution_id)).map((row) => [row.request_sent, row.outcome, row.charged_cost]))
    .toEqual([[true, "failed", 0.01], [false, null, 0]]);
  // The sent request stays charged and the new claim holds its reservation.
  expect((await readRunSpend(db, tenant, "run-1")).committed).toBeCloseTo(0.02, 10);
  expect((await completeExecution(db, tenant, second.claim, { answer: { state: "answered", kind: "choice", value: "relevant" } })).ok).toBe(true);
  expect((await completeExecution(db, tenant, second.claim, { answer: { state: "answered", kind: "choice", value: "relevant" } })))
    .toEqual(ok({ kind: "stale_claim", execution_id: second.claim.execution_id }));
  expect(await life.counts()).toMatchObject({ answers: 1 });
}));

integration("simultaneous claims cannot spend the same remaining run allowance", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  await captureAssessment(life);
  // Each request is estimated at 0.01: an allowance of 0.025 fits exactly two.
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    claimNext(db, tenant, { lease_owner: `w${index}`, lease_ms: 60_000, run_spend: 0.025 })));
  expect(results.filter((result) => result.kind === "claimed")).toHaveLength(2);
  expect(results.filter((result) => result.kind === "budget_deferred")).toHaveLength(4);
  const spend = await readRunSpend(db, tenant, "run-1");
  expect([spend.committed, spend.requests_sent, spend.executions.budget_deferred, spend.executions.claimed]).toEqual([0.02, 0, 4, 2]);
  expect(await life.counts()).toMatchObject({ answers: 0 });
}));

integration("deferral sends nothing and writes no answer; a released reservation offers deferred work again", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true);
  await captureAssessment(life);
  const deps = life.worker(firstAllowed, { controls: { run_spend: 0.01, retry_limit: 3, provider_deadline_ms: 30_000, lease_ms: 60_000 } });
  await life.drain(deps);
  const spend = await readRunSpend(db, tenant, "run-1");
  expect([spend.executions.completed, spend.executions.budget_deferred, spend.requests_sent, life.requests.sent.length]).toEqual([1, 8, 1, 1]);
  const deferred = (await executionsOf(db)).find((row) => row.status === "budget_deferred")!;
  const measured = await readItemMeasurements(db, tenant, await occurrenceAt(db, deferred.revision_id, deferred.json_pointer));
  expect(measured?.questions.flatMap((entry) => entry.machine.map((machine) => machine.measurement.state))).toContain("budget_deferred");
  expect(await life.counts()).toMatchObject({ answers: 1 });
  // A larger allowance (a restart with a new setting) lets the deferred work through.
  const restarted = { ...deps, lease_owner: "worker-b", controls: { ...deps.controls, run_spend: 0.03 } };
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution").set({ status: "queued" })
    .where("status", "=", "budget_deferred").execute());
  await life.drain(restarted);
  expect((await readRunSpend(db, tenant, "run-1")).executions).toMatchObject({ completed: 3, budget_deferred: 6 });
  // A claim that ends without a request releases its reservation and re-queues the run's deferred work.
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution").set({ status: "queued" })
    .where("status", "=", "budget_deferred").execute());
  const tight = { run_spend: 0.04, lease_owner: "c", lease_ms: 60_000 };
  const claimed = await claimNext(db, tenant, tight);
  if (claimed.kind !== "claimed") throw new Error(claimed.kind);
  expect((await claimNext(db, tenant, tight)).kind).toBe("budget_deferred");
  await failExecution(db, tenant, claimed.claim, { category: "unconfigured_credential", detail: "no key", provider_request_id: null, provider_cost: null });
  expect((await readRunSpend(db, tenant, "run-1")).executions.budget_deferred).toBe(0);
}));

integration("each run has its own allowance", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  await captureAnalysis(life, true, "run-1");
  await captureAnalysis(life, true, "run-2");
  await life.drain(life.worker(firstAllowed, { controls: { run_spend: 0.01, retry_limit: 3, provider_deadline_ms: 30_000, lease_ms: 60_000 } }));
  expect(await life.counts()).toMatchObject({ executions: 2, completed: 2, answers: 2 });
}));

integration("accept and request-changes delivered over HTTP start no pass and admit nothing for ready, unmeasured items", async () => scratchDatabase(async (db) => {
  const life = await lifecycle(db);
  // Supported, ready and unmeasured: captured and collected on an enabled run, but never admitted.
  await life.feed.launch(LAUNCH, "run-1", runConfig(true));
  let cursor = await life.feed.revision({ revision_id: "run-1-analysis", artifact_kind: "analysis", run_id: "run-1", body: await fixtureBody("analysis") });
  await createEvidenceReconciler({ db, collector: oakridgeProfile.evidence, repository, log: () => undefined }).reconcileRun(tenant, "run-1");
  expect(await life.counts()).toMatchObject({ ready: 1, executions: 0 });
  const passes: string[] = [];
  const evidence: EvidenceReconciler = { ...life.reconciler,
    reconcileRun: (scope, run_id) => { passes.push(run_id); return life.reconciler.reconcileRun(scope, run_id); } };
  const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest-secret" }], read: [] }, profile: oakridgeProfile, evidence });
  for (const [index, decision] of ["accept", "request-changes"].entries()) {
    const next = { commit_txid: String(3 + index), id: `decision:${decision}` };
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
      headers: { authorization: "Bearer ingest-secret", "content-type": "application/json" },
      body: JSON.stringify({ previous: cursor, cursor: next, outcome: { format: "observation.source-event/v1", definition_id: DEFINITION_ID,
        artifact_schema_version: SCHEMA_VERSION, kind: "ignored", event_kind: "operator_decided", run_id: "run-1", event_id: next.id } }) });
    expect(response.status).toBe(200);
    cursor = next;
  }
  await Bun.sleep(200);
  expect(passes).toEqual([]);
  expect(await life.counts()).toMatchObject({ executions: 0, attempts: 0, answers: 0 });
  // The same items were admittable all along: a pass started by anything else admits them.
  await life.reconciler.reconcileRun(tenant, "run-1");
  expect((await life.counts()).executions).toBe(1);
}));
