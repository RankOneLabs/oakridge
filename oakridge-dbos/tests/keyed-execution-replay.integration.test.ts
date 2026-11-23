import { expect, test } from "bun:test";
import { CoreClient } from "../src/core-client/client";
import type { WorkflowDefinitionDescriptor } from "../src/core-client/source-types";
import type { ExecutionEvidence, KeyedExecutionRecovery } from "../src/domain/keyed-execution";
import { openDatabase } from "../src/storage/database";
import { claimStart } from "../src/storage/executor-store";
import { openAuthority, type Authority } from "./authority-fixture";
import { attachExecutionHttp, openStudy, type StudyRun } from "./study-fixture";

const prompt = "generic-runner.md";
const source: WorkflowDefinitionDescriptor = {
  workflow: "execution_fixture", input: {}, run: { units: { work: { stage: "work" } }, outcome: {} },
  stages: { work: { input: {}, outcome: {}, done_when: "false", artifacts: {
    request: { kind: "document", schema: "text" },
    report: { kind: "document", schema: { results: "list(text)" }, validate: [{ check: "len(report.results) > 0", message: "Add results" }] },
  }, workers: {
    requester: { kind: "agent", inputs: {}, prompts: { initial: prompt }, produces: ["request"] },
    runner: { kind: "agent", inputs: {}, prompts: { review: prompt, revise: prompt }, evaluates: "request",
      when: "approved(request)", keyed_execution: true, produces: ["report"] },
  }, reviews: { approval: { of: "request", by: "operator", prompt, decisions: { approve: { effect: "approve", label: "Approve" } } } } } },
};

class FakeRunner {
  readonly launches: string[] = [];
  private readonly accepted = new Map<string, ExecutionEvidence>();
  launch(key: string, accepts = true): ExecutionEvidence | null {
    this.launches.push(key);
    const evidence = { external_id: `external-${key}`, store_path: "/test/results", detail: "Accepted" };
    if (!accepts) return null;
    this.accepted.set(key, evidence);
    return evidence;
  }
  lookup(key: string): ExecutionEvidence {
    const evidence = this.accepted.get(key);
    if (!evidence) throw new Error("No accepted launch for key");
    return evidence;
  }
}

async function ready(authority: Authority, recovery: KeyedExecutionRecovery) {
  const run = await openStudy(authority, { source, input: {}, unit: "work", recovery,
    prompt_edit: { path: prompt, content: "Run the approved execution." } });
  await run.publish("requester", "request", "Run the fake execution");
  await run.end("requester");
  expect((await run.decide("approval", "approve", "request")).status).toBe(201);
  return run;
}

function endpoints(run: StudyRun, attempt: Awaited<ReturnType<StudyRun["startRunner"]>>, http = run.app) {
  const url = `/executions/${attempt.key}`;
  return {
    claim: () => run.request("POST", `${url}/claim`, { request_id: crypto.randomUUID() }, attempt.secret, run.unit(), http).then((r) => r.json()),
    evidence: (evidence: ExecutionEvidence) => run.request("PUT", `${url}/evidence`, { request_id: crypto.randomUUID(), evidence },
      attempt.secret, run.unit(), http),
    reconcile: (outcome: object) => run.request("POST", `${url}/reconciliation`, { request_id: crypto.randomUUID(), outcome }, undefined, run.unit(), http),
  };
}

test("by_key recovers one accepted launch across concurrent claims and report correction", async () => {
  const authority = await openAuthority();
  try {
    const run = await ready(authority, "by_key");
    const fake = new FakeRunner();
    const first = await run.startRunner("runner");
    expect(await endpoints(run, first).claim()).toEqual({ kind: "launch" });
    fake.launch(first.key);
    await run.end("runner", run.unit(), false);
    expect((await run.retry("runner")).status).toBe(201);
    const resumed = await run.startRunner("runner");
    expect(resumed.key).toBe(first.key);
    const calls = endpoints(run, resumed);
    const answers = await Promise.all([calls.claim(), calls.claim()]);
    expect(answers).toEqual([{ kind: "recover" }, { kind: "recover" }]);
    const evidence = fake.lookup(resumed.key);
    expect((await calls.evidence(evidence)).status).toBe(200);
    expect((await calls.evidence(evidence)).status).toBe(200);
    expect((await calls.evidence({ ...evidence, detail: "Different" })).status).toBe(409);
    const subject = (await run.revision("request"))!.id;
    await run.publish("runner", "report", { results: [] }, { subject });
    await run.end("runner");
    const revision = await run.startRunner("runner");
    expect(revision.key).toBe(first.key);
    expect(await endpoints(run, revision).claim()).toEqual({ kind: "resume", evidence });
    await run.publish("runner", "report", { results: ["Recovered"] }, { subject });
    await run.end("runner");
    expect(fake.launches).toEqual([first.key]);
  } finally { await authority.close(); }
});

test("off preserves the pause across a restart and resumes reconciled evidence", async () => {
  const authority = await openAuthority();
  try {
    const run = await ready(authority, "off");
    const fake = new FakeRunner();
    const first = await run.startRunner("runner");
    expect(await endpoints(run, first).claim()).toEqual({ kind: "launch" });
    const evidence = fake.launch(first.key)!;
    await run.end("runner", run.unit(), false);
    expect((await run.retry("runner")).status).toBe(201);
    const second = await run.startRunner("runner");
    expect(second.key).toBe(first.key);
    expect(await endpoints(run, second).claim()).toEqual({ kind: "reconcile_required" });
    const db = openDatabase(authority.url);
    const started = CoreClient.start();
    if (!started.ok) throw new Error("core did not start");
    try {
      const reopened = attachExecutionHttp({ db, core: started.value });
      await db.updateTable("authority.effect_intent").set({ next_try_at: new Date(0) }).where("id", "=", second.intent.id).execute();
      expect(await claimStart(db, { intent_id: second.intent.id, max_tries: 3 })).toMatchObject({ kind: "not_pending" });
      expect(fake.launches).toEqual([first.key]);
      await run.end("runner", run.unit(), false);
      expect((await endpoints(run, second, reopened).reconcile({ kind: "evidence", evidence })).status).toBe(200);
      const third = await run.startRunner("runner");
      expect(third.key).toBe(first.key);
      expect(await endpoints(run, third, reopened).claim()).toEqual({ kind: "resume", evidence });
      expect(fake.launches).toEqual([first.key]);
    } finally { started.value.close(); await db.destroy(); }
  } finally { await authority.close(); }
});

test("never_accepted permits a new launch under the original execution key", async () => {
  const authority = await openAuthority();
  try {
    const run = await ready(authority, "off");
    const first = await run.startRunner("runner");
    expect(await endpoints(run, first).claim()).toEqual({ kind: "launch" });
    const fake = new FakeRunner();
    expect(fake.launch(first.key, false)).toBeNull();
    await run.end("runner", run.unit(), false);
    expect((await run.retry("runner")).status).toBe(201);
    const second = await run.startRunner("runner");
    expect(await endpoints(run, second).claim()).toEqual({ kind: "reconcile_required" });
    await run.end("runner", run.unit(), false);
    expect((await endpoints(run, second).reconcile({ kind: "never_accepted" })).status).toBe(200);
    const third = await run.startRunner("runner");
    expect(third.key).toBe(first.key);
    expect(await endpoints(run, third).claim()).toEqual({ kind: "launch" });
    fake.launch(third.key);
    expect(fake.launches).toEqual([first.key, first.key]);
  } finally { await authority.close(); }
});
