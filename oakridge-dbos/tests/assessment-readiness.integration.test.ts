import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Workflow } from "../src/core-client/core-types";
import { commitEvent } from "../src/storage/commit";
import { openAuthority, OPERATOR, type Authority } from "./authority-fixture";
import { assessmentWorkflow, cleanAssessment, openAssessmentRun } from "./assessment-fixture";

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority?.close(); });

const stage = { ...assessmentWorkflow.stages.work, outcome: { work: "latest(part_a)" },
  done_when: "approved(assessment) and published(part_a)" };
const joined = {
  input: { left: { text: "text" }, right: { text: "text" } },
  artifacts: { result: { kind: "record", schema: "text" } },
  workers: { joined: { kind: "agent", inputs: { topic: "input.left.text" }, prompts: { initial: "review-loop/write.md" }, produces: ["result"] } },
  done_when: "published(result)", outcome: {},
} satisfies Workflow["stages"][string];

async function assess(run: Awaited<ReturnType<typeof openAssessmentRun>>, unit: string) {
  expect(await run.publish({ worker: "builder_a", unit, artifact: "part_a", body: { text: unit } })).toMatchObject({ value: { kind: "committed" } });
  await run.end("builder_a", unit);
  const work = (await run.revision("part_a", unit))!.id;
  expect(await run.publish({ worker: "assessor", unit, artifact: "assessment", body: cleanAssessment, subject: work })).toMatchObject({ value: { kind: "committed" } });
  await run.end("assessor", unit);
}
async function approve(run: Awaited<ReturnType<typeof openAssessmentRun>>, unit: string) {
  const target = (await run.revision("assessment", unit))!.id;
  const assessed_revision = (await run.revision("part_a", unit))!.id;
  expect(await commitEvent({ ...authority, wake: () => undefined }, { run_id: run.run_id, ingress_id: crypto.randomUUID(), writer: OPERATOR,
    assessment_decision: { decision: "approve", target, assessed_revision, dispositions: [] },
    event: { kind: "operator_decided", unit, review: "assessment_review", decision: "approve", target, payload: {} },
  })).toMatchObject({ value: { kind: "committed" } });
}
const unitStatus = (id: string) => authority.db.selectFrom("authority.unit").select(["status", "blocked_reason"]).where("id", "=", id).executeTakeFirstOrThrow();

test("dependent attempt is admitted only after both predecessor assessments are approved", async () => {
  const source: Workflow = { ...assessmentWorkflow, stages: { left: stage, right: stage, joined }, run: { outcome: {}, units: {
    left: { stage: "left" }, right: { stage: "right" }, joined: { stage: "joined", input: { left: "left.outcome.work", right: "right.outcome.work" } },
  } } };
  const run = await openAssessmentRun(authority, source);
  const [left, right, dependent] = ["left", "right", "joined"].map(key => `${run.run_id}/${key}`);
  await assess(run, left);
  await assess(run, right);
  const before = await run.counts();
  await approve(run, left);
  expect((await unitStatus(left)).status.kind).toBe("done");
  expect((await unitStatus(right)).status.kind).toBe("active");
  expect((await unitStatus(dependent)).status.kind).toBe("not_started");
  expect(await run.counts()).toEqual(before);
  await approve(run, right);
  expect((await run.action("joined", dependent)).status.kind).toBe("pending");
  expect(await run.counts()).toEqual({ ...before, intents: before.intents + 1 });
});

function collection(capacity: number, after: readonly string[]) {
  const source: Workflow = { ...assessmentWorkflow, input: { members: "list({key: ident, after: list(ident)})" },
    stages: { work: stage }, run: { outcome: {}, pools: { p: capacity },
      units: { member: { for_each: "input.members", key: "each.key", after: "each.after", stage: "work", pool: "p" } },
    } };
  return openAssessmentRun(authority, source, { members: [{ key: "a", after: [] }, { key: "b", after }] });
}
test("collection after waits for approval and admits its next member after it commits", async () => {
  const run = await collection(2, ["a"]);
  const a = `${run.run_id}/a`;
  const b = `${run.run_id}/b`;
  await assess(run, a);
  expect((await unitStatus(b)).status.kind).toBe("not_started");
  await approve(run, a);
  expect((await run.action("builder_a", b)).status.kind).toBe("pending");
  expect(await run.counts()).toMatchObject({ assignments: 0, rounds: 0 });
});
test("pool capacity counts members awaiting approval and admits independent members when slots exist", async () => {
  const one = await collection(1, []);
  await assess(one, `${one.run_id}/a`);
  expect(await unitStatus(`${one.run_id}/b`)).toMatchObject({ status: { kind: "not_started" }, blocked_reason: { kind: "capacity", pool: "p" } });
  const two = await collection(2, []);
  expect(await Promise.all(["a", "b"].map(async key => (await unitStatus(`${two.run_id}/${key}`)).status.kind))).toEqual(["active", "active"]);
  expect(await two.counts()).toMatchObject({ assignments: 0, rounds: 0 });
});
