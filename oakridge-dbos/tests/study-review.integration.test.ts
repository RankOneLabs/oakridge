import { expect, test } from "bun:test";
import { openAuthority } from "./authority-fixture";
import { openStudy, paid, pr, prepareSlice, sliceAssessment, sliceBuild, spend, type StudyRun } from "./study-fixture";

const evidence = { external_id: "runner-result", store_path: "/results", detail: "Accepted" };
const instruction = "Correct the test evidence.";

async function committed(response: Response) {
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 201 });
}
async function approveSpend(run: StudyRun) {
  await committed(await run.decide("spend_request_review", "approve", "spend_request"));
  const runner = await run.startRunner();
  const endpoint = `/executions/${runner.key}`;
  const claim = await run.request("POST", `${endpoint}/claim`, { request_id: crypto.randomUUID() }, runner.secret);
  expect(await claim.json()).toEqual({ kind: "launch" });
  expect((await run.request("PUT", `${endpoint}/evidence`, { request_id: crypto.randomUUID(), evidence }, runner.secret)).status).toBe(200);
  return runner;
}

async function seedAssessment(run: StudyRun, proposals: readonly { key: string; instruction: string }[] = []) {
  const authorization = await prepareSlice(run);
  await run.end("spend_requester");
  const runner = await approveSpend(run);
  const report = await run.publish("slice_runner", "slice_report", paid(runner.key), { subject: authorization.id });
  await run.end("slice_runner");
  const assessment = await run.publish("slice_assessor", "slice_assessment", { ...sliceAssessment(runner.key), proposals }, { subject: report.id });
  await run.end("slice_assessor");
  return { assessment, report, key: runner.key };
}

async function authorize(run: StudyRun, item: string, target_revision: string, worker: string) {
  const recipients = [worker];
  await committed(await run.request("POST", `/feedback/${item}/authorizations`, {
    request_id: crypto.randomUUID(), item, target_revision, instruction, recipients,
  }));
  return { kind: "dispatch", item, instruction, recipients } as const;
}

test("direct correction wants the assessor alone and reopens assessment review", async () => {
  const authority = await openAuthority();
  try {
    const run = await openStudy(authority);
    const { assessment, report, key } = await seedAssessment(run);
    const feedback = await run.request("POST", "/assessments/slice_assessment/feedback", { request_id: crypto.randomUUID(), instruction });
    expect(feedback.status).toBe(201);
    const { item_id } = await feedback.json() as { item_id: string };
    const disposition = await authorize(run, item_id, assessment.id, "slice_assessor");
    await committed(await run.decide("slice_assessment_review", "correct_assessment", "slice_assessment", {
      assessed_revision: report.id, dispositions: [disposition],
    }));
    const action = await run.action("slice_assessor");
    expect(action.cause.kind).toBe("assignment_round");
    for (const worker of ["slice_builder", "spend_requester", "slice_runner"]) expect((await run.action(worker)).status.kind).toBe("succeeded");
    const round = await authority.db.selectFrom("authority.assignment_round").select("id").where("action_id", "=", action.action_id).executeTakeFirstOrThrow();
    const updated = await run.publish("slice_assessor", "slice_assessment", {
      ...sliceAssessment(key), verifications: [{ round_id: round.id, outcome: "verified" }],
    }, { subject: report.id });
    await run.end("slice_assessor");
    expect((await run.reviews()).slice_assessment_review?.target).toBe(updated.id);
    expect(await authority.db.selectFrom("authority.assignment_verification").select("round_id").execute())
      .toEqual([{ round_id: round.id }]);
  } finally { await authority.close(); }
});

test("dispatch to the builder withholds expansion after merge until reassessment and explicit approval", async () => {
  const authority = await openAuthority();
  try {
    const run = await openStudy(authority);
    const { report, key } = await seedAssessment(run, [{ key: "fix", instruction }]);
    await run.code("pr_watch", run.unit());
    await run.code("prepare_observed_state", run.unit());
    const { id } = await authority.db.selectFrom("authority.feedback_item").select("id").executeTakeFirstOrThrow();
    const target = (await run.revision("slice_build"))!.id;
    const disposition = await authorize(run, id, target, "slice_builder");
    await committed(await run.decide("slice_assessment_review", "send_feedback_to_builder", "slice_assessment", {
      assessed_revision: report.id, dispositions: [disposition],
    }));
    expect((await run.reviews()).slice_report_review).toBeUndefined();
    expect((await run.reviews()).merge_confirmation).toBeUndefined();
    expect((await run.action("slice_builder")).cause.kind).toBe("assignment_round");
    expect(await authority.db.selectFrom("authority.unit").select("id").where("stage", "=", "expand").execute()).toEqual([]);
    expect((await run.decide("slice_assessment_review", "approve_assessment", "slice_assessment", {
      assessed_revision: report.id, dispositions: [],
    })).status).toBe(409);
    await run.publish("slice_builder", "slice_build", sliceBuild);
    await run.publish("slice_builder", "pr", pr("slice", 1));
    await run.end("slice_builder");
    expect((await run.action("slice_assessor")).cause.kind).toBe("reassessment");
    const round = await authority.db.selectFrom("authority.assignment_round").select("id").executeTakeFirstOrThrow();
    await run.publish("slice_assessor", "slice_assessment", {
      ...sliceAssessment(key), verifications: [{ round_id: round.id, outcome: "verified" }],
    }, { subject: report.id });
    await run.end("slice_assessor");
    await committed(await run.decide("slice_assessment_review", "approve_assessment", "slice_assessment", {
      assessed_revision: report.id, dispositions: [],
    }));
    expect((await run.reviews()).slice_report_review?.decisions.some((decision) => decision.decision === "expand" && decision.is_available !== false)).toBe(true);
    expect(await authority.db.selectFrom("authority.unit").select("id").where("stage", "=", "expand").execute()).toEqual([]);
    await committed(await run.decide("slice_report_review", "expand", "slice_report"));
    expect(await authority.db.selectFrom("authority.unit").select("id").where("stage", "=", "expand").execute()).toHaveLength(2);
  } finally { await authority.close(); }
});

test("spend changes revise the request and a refused paid report resumes the same execution", async () => {
  const authority = await openAuthority();
  try {
    const run = await openStudy(authority);
    const initial = await prepareSlice(run);
    await run.end("spend_requester");
    await committed(await run.decide("spend_request_review", "request_changes", "spend_request", { payload: { feedback: "Clarify cap" } }));
    expect(await authority.db.selectFrom("authority.keyed_execution").select("id").execute()).toEqual([]);
    const authorized = await run.publish("spend_requester", "spend_request", spend, { subject: initial.subject! });
    await run.end("spend_requester");
    const first = await approveSpend(run);
    await run.publish("slice_runner", "slice_report", paid(first.key, false), { subject: authorized.id });
    await run.end("slice_runner");
    const revised = await run.startRunner();
    expect(revised.key).toBe(first.key);
    expect(await (await run.request("POST", `/executions/${revised.key}/claim`, { request_id: crypto.randomUUID() }, revised.secret)).json())
      .toEqual({ kind: "resume", evidence });
    await run.publish("slice_runner", "slice_report", paid(revised.key), { subject: authorized.id });
    await run.end("slice_runner");
    expect((await run.revision("spend_request"))?.id).toBe(authorized.id);
    expect((await run.reviews()).spend_request_review).toBeUndefined();
  } finally { await authority.close(); }
});
