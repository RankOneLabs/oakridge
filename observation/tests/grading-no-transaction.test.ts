import { expect, test } from "bun:test";
import type { Database } from "../src/storage/database";
import type { GradeRunner } from "../src/ports/grade-runner";
import { registerGradingContext, runGrade } from "../src/storage/grading-store";
import { enqueueJob } from "../src/storage/grading-job-store";
import { workOneJob } from "../src/grading/jobs/worker";
import { gradingLimits } from "../src/grading/jobs/budget";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
/** Count transaction callbacks rather than relying on an implementation-specific connection trace. */
function traced(db: Database) {
  let depth = 0;
  const instrumented = new Proxy(db, { get(target, property) {
    if (property === "transaction") return () => {
      const builder = target.transaction();
      return { execute: <T>(work: (trx: Parameters<Parameters<typeof builder.execute>[0]>[0]) => Promise<T>) =>
        builder.execute(async (trx) => { depth++; try { return await work(trx); } finally { depth--; } }) };
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Database;
  return { db: instrumented, depth: () => depth };
}
for (const queued of [false, true]) {
  integration(`${queued ? "queued" : "manual"} runner executes outside withTenant`, async () => scratchGrading(async (database, occurrence_id) => {
    const trace = traced(database);
    const context = { question, evidence, evaluator: evaluator(queued ? "model" : "code") };
    expect((await registerGradingContext(trace.db, tenant, context)).ok).toBe(true);
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: queued ? "model" : "code", config_digest: "config-1", attempt_label: queued ? "queued" : "manual" };
    let calls = 0;
    const runner: GradeRunner = { kind: queued ? "model" : "code", async run() {
      expect(trace.depth()).toBe(0); calls++;
      return { ok: true, value: { answer: { state: "answered", kind: "boolean", value: true } } };
    } };
    if (queued) {
      await enqueueJob(trace.db, tenant, { identity, runner_name: "stub_model" }, gradingLimits());
      await workOneJob(trace.db, tenant, gradingLimits(), "trace-worker", runner);
    } else expect((await runGrade(trace.db, tenant, { identity, runner })).ok).toBe(true);
    expect(calls).toBe(1);
    expect(trace.depth()).toBe(0);
  }));
}
