import { KbblClient } from "../src/adapters/kbbl";
import { createAgentProvider } from "../src/effects/agent-provider";
import { startStubKbbl } from "./stub-kbbl";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { AssessmentStatus, FeedbackProposal, Workflow } from "../src/core-client/core-types";
import { renderTaskPublication } from "../src/effects/session-prompt";
import { selectDeliveryKey } from "../src/effects/delivery-key";
import { cleanAssessment, openAssessmentRun, openReturnedAssessment, sampleProposal, type AssessmentBody } from "./assessment-fixture";
import { openAuthority, type Authority } from "./authority-fixture";

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority?.close(); });

async function prepared(assessment = cleanAssessment) {
  const run = await openAssessmentRun(authority);
  expect(await run.publish({ worker: "builder_a", artifact: "part_a", body: { text: "a" } })).toMatchObject({ ok: true, value: { kind: "committed" } });
  await run.end("builder_a");
  expect(await run.publish({ worker: "builder_b", artifact: "part_b", body: { text: "b" } })).toMatchObject({ ok: true, value: { kind: "committed" } });
  await run.end("builder_b");
  return { ...run, assessment, subject: (await run.revision("part_a"))!.id };
}
async function assessed(proposal?: FeedbackProposal) {
  const assessment: AssessmentBody = proposal ? { ...cleanAssessment, observations: [{ id: "finding", fix: proposal }], verdict: "fail" } : cleanAssessment;
  const run = await prepared(assessment);
  expect(await run.publish({ worker: "assessor", artifact: "assessment", body: assessment, subject: run.subject })).toMatchObject({ value: { kind: "committed" } });
  await run.end("assessor");
  return run;
}
async function withoutProposal() {
  const run = await prepared();
  expect(await run.publish({ worker: "assessor", artifact: "assessment", body: { ...cleanAssessment, observations: [{ id: "finding" }] }, subject: run.subject }))
    .toMatchObject({ value: { kind: "committed" } });
  return run;
}
const dispatch = (item: string, instruction = sampleProposal.instruction, recipients = ["builder_a", "builder_b"]) =>
  ({ decision: "send", dispositions: [{ kind: "dispatch" as const, item, instruction, recipients }] });
async function assigned() {
  const run = await assessed(sampleProposal);
  const [{ id: item }] = await run.rows("authority.feedback_item");
  expect((await run.authorize(item, run.subject, sampleProposal.instruction, ["builder_a", "builder_b"])).status).toBe(201);
  expect((await run.decide(dispatch(item))).status).toBe(201);
  return { ...run, item };
}
async function update(run: Pick<Awaited<ReturnType<typeof openAssessmentRun>>, "publish" | "end">, worker: "builder_a" | "builder_b", text: string) {
  expect(await run.publish({ worker, artifact: worker === "builder_a" ? "part_a" : "part_b", body: { text } }))
    .toMatchObject({ value: { kind: "committed" } });
  await run.end(worker);
}

test("clean assessment waits for final approval and an approval replay preserves decision identity", async () => {
  const run = await assessed();
  expect(await (await run.status()).json()).toMatchObject({ approval: { kind: "pending" } });
  const before = await run.counts();
  const request_id = crypto.randomUUID();
  const response = await run.decide({ decision: "approve" }, request_id);
  expect(response.status).toBe(201);
  expect(await (await run.decide({ decision: "approve" }, request_id)).json()).toEqual(await response.json());
  expect(await (await run.status()).json()).toMatchObject({ approval: { kind: "approved" } });
  expect(await run.rows("authority.assessment_approval")).toMatchObject([{ assessment_revision_id: (await run.revision("assessment"))!.id }]);
  expect(await (await run.decide({ decision: "approve" })).text()).toContain("approval is final");
  expect(await (await run.decide({ decision: "send" })).text()).toContain("approval is final");
  expect(await run.counts()).toEqual(before);
});

test("a renamed self-assessment uses its review and output to bind and prompt for the latest subject", async () => {
  const source = {
    workflow: "delivery", input: {},
    run: { units: { handoff: { stage: "assemble" } }, outcome: {} },
    stages: { assemble: {
      input: {}, outcome: {}, done_when: "approved(checklist)",
      artifacts: {
        candidate: { kind: "record", schema: "text" },
        checklist: { kind: "assessment", schema: "text" },
      },
      workers: { assembler: {
        kind: "agent", inputs: { topic: '"delivery"' }, produces: ["candidate", "checklist"],
        prompts: { initial: "review-loop/write.md", revise: "review-loop/revise.md" },
      } },
      reviews: { signoff: { by: "operator", of: "checklist", prompt: "review-loop/editor.md", decisions: {
        approve: { effect: "approve", operation: "approve_assessment", label: "Approve" },
        return_work: { effect: "request_changes", operation: "dispatch_feedback", on: "checklist", label: "Return" },
      } } },
    } },
  } satisfies Workflow;
  const run = await openAssessmentRun(authority, source);
  const unit = `${run.run_id}/handoff`;
  const [intent] = await run.rows("authority.effect_intent");
  expect(intent?.payload.engine_inputs.self_assessment).toEqual([{ assessment: "checklist", subject_artifact: "candidate" }]);
  expect(renderTaskPublication(intent!.payload, { prompt_text: "", handoff_text: null, latest: [], previous_attempt: null }))
    .toContain("Publish `candidate` first. For `checklist`, send the exact latest `candidate` revision as `subject`.");

  const publish = (artifact: string, body: string, subject?: string) =>
    run.publish({ unit, worker: "assembler", artifact, body, subject });
  const refusal = { value: { kind: "rejected", reason: expect.stringContaining("exact latest candidate revision") } };
  expect(await publish("checklist", "reviewed")).toMatchObject(refusal);
  expect(await publish("candidate", "first")).toMatchObject({ value: { kind: "committed" } });
  const first = (await run.revision("candidate", unit))!.id;
  expect(await publish("candidate", "second")).toMatchObject({ value: { kind: "committed" } });
  const latest = (await run.revision("candidate", unit))!.id;
  expect(await publish("checklist", "reviewed", first)).toMatchObject(refusal);
  expect(await publish("checklist", "reviewed", latest)).toMatchObject({ value: { kind: "committed" } });
  expect(await run.revision("checklist", unit)).toMatchObject({ subject: latest });
});

test("renamed proposal paths bind once and publication replays preserve the item id", async () => {
  const run = await prepared();
  const publication = { worker: "assessor", artifact: "assessment", body: { ...cleanAssessment, observations: [{ id: "obs", fix: sampleProposal }] },
    subject: run.subject, predecessor: null, request_id: crypto.randomUUID() };
  expect(await run.publish(publication)).toMatchObject({ value: { kind: "committed" } });
  const [item] = await run.rows("authority.feedback_item");
  expect(await run.publish(publication)).toMatchObject({ value: { kind: "replayed" } });
  expect(await run.rows("authority.feedback_item")).toMatchObject([{ id: item.id, proposal_key: sampleProposal.key }]);
  expect(await run.counts()).toMatchObject({ assignments: 0, rounds: 0 });
});

for (const missing of ["revision", "pointer"]) test(`unresolved citation ${missing} refuses the publication atomically`, async () => {
  const run = await prepared();
  const citation = { revision_id: missing === "revision" ? "absent" : run.subject, pointer: "/absent" };
  const result = await run.publish({ worker: "assessor", artifact: "assessment", body: { ...cleanAssessment,
    observations: [{ id: "obs", fix: { ...sampleProposal, citation } }] }, subject: run.subject });
  expect(result).toMatchObject({ value: { kind: "rejected", reason: `citation ${citation.revision_id}#/absent does not resolve` } });
  expect(await run.rows("authority.feedback_item")).toEqual([]);
  expect(await run.revision("assessment")).toBeUndefined();
});

test("dispatch matches the exact authorization, creates a round and intent per recipient, and replays", async () => {
  const run = await assessed(sampleProposal);
  const [{ id: item }] = await run.rows("authority.feedback_item");
  const before = await run.counts();
  expect(await (await run.decide(dispatch(item))).text()).toContain("dispatch not authorized");
  expect((await run.authorize(item, run.subject, sampleProposal.instruction, ["builder_a", "builder_b"], crypto.randomUUID(), "session-secret")).status).toBe(401);
  expect(await (await run.authorize(item, run.subject, sampleProposal.instruction, ["watch"])).text()).toContain("not an agent worker");
  expect(await (await run.authorize(item, run.subject, sampleProposal.instruction, ["other_stage_worker"])).text()).toContain("not an agent worker");
  expect((await run.authorize(item, run.subject, sampleProposal.instruction, ["builder_b", "builder_a"])).status).toBe(201);
  expect(await (await run.decide(dispatch(item, "Changed instruction"))).text()).toContain("dispatch not authorized");
  expect(await (await run.decide(dispatch(item, sampleProposal.instruction, ["builder_a", "builder_b", "assessor"]))).text()).toContain("dispatch not authorized");
  const request_id = crypto.randomUUID();
  const response = await run.decide(dispatch(item), request_id);
  expect(await response.clone().text()).toContain("committed");
  expect(await (await run.decide(dispatch(item), request_id)).json()).toEqual(await response.json());
  expect(await run.counts()).toEqual({ assignments: 2, rounds: 2, intents: before.intents + 2 });
  const intents = (await run.rows("authority.effect_intent")).filter(intent => intent.payload.action.cause.kind === "assignment_round");
  expect(intents.map(intent => selectDeliveryKey(intent.payload)).sort()).toEqual((await run.rows("authority.assignment_round")).map(round => round.id).sort());
});

test("dispatch persists two rounds for one worker and binds each intent when admitted", async () => {
  const run = await prepared();
  const body = { ...cleanAssessment, observations: [sampleProposal, { ...sampleProposal, key: "other" }]
    .map((fix, index) => ({ id: `finding_${index}`, fix })) };
  expect(await run.publish({ worker: "assessor", artifact: "assessment", subject: run.subject, body }))
    .toMatchObject({ value: { kind: "committed" } });
  await run.end("assessor");
  const items = await run.rows("authority.feedback_item");
  const recipients = ["builder_b"];
  const instruction = sampleProposal.instruction;
  for (const item of items) expect((await run.authorize(item.id, run.subject, instruction, recipients)).status).toBe(201);
  const before = await run.counts();
  expect((await run.decide({ decision: "send", dispositions: items.map(item => ({ kind: "dispatch", item: item.id, instruction, recipients })) })).status).toBe(201);
  expect(await run.counts()).toEqual({ assignments: 2, rounds: 2, intents: before.intents + 1 });
  const queued = (await run.rows("authority.assignment_round")).find(round => round.action_id === null)!;
  expect(queued).toBeDefined();
  expect(await run.publish({ worker: "builder_b", artifact: "part_b", body: { text: "first update" } })).toMatchObject({ value: { kind: "committed" } });
  expect((await run.rows("authority.assignment_round")).find(round => round.id === queued.id)?.action_id).toBeNull();
  await run.end("builder_b");
  const admitted = (await run.rows("authority.assignment_round")).find(round => round.id === queued.id);
  expect(admitted?.action_id).toBe((await run.action("builder_b")).action_id);
  expect((await run.rows("authority.effect_intent")).find(intent => intent.action_id === admitted?.action_id)?.payload.engine_inputs.round_delivery)
    .toContain(queued.id);
});

test("an explicit retry delivers the same round again without duplicating either delivery", async () => {
  const run = await assigned();
  const initial = await run.action("builder_b");
  const round = (await run.rows("authority.assignment_round")).find(value => value.action_id === initial.action_id)!;
  const kbbl = startStubKbbl(async turn => turn.delivery_key === round.id ? "failed" : "succeeded");
  try {
    const provider = createAgentProvider({ kbbl: new KbblClient({ base_url: kbbl.url, control_token: null }),
      publication_key: "test-publication-key", publish_base_url: "http://localhost", default_workdir: "/tmp" });
    const deliver = async (action: string) => {
      const instruction = (await run.rows("authority.effect_intent")).find(intent => intent.action_id === action)!.payload;
      const start = await provider.start(instruction);
      if (start.kind !== "acknowledged") throw new Error(JSON.stringify(start));
      const material = { task: instruction.engine_inputs.round_delivery! };
      await provider.observe(instruction, material, start.value.handle);
      await provider.observe(instruction, material, start.value.handle);
      return instruction;
    };
    const first = await deliver(initial.action_id);
    expect(await run.send({ run_id: run.run_id, writer: { kind: "executor", attempt: initial.action_id },
      event: { kind: "worker_ended", action: initial.action_id, result: { kind: "failed", code: "unavailable", detail: "First delivery failed" } } }))
      .toMatchObject({ value: { kind: "committed" } });
    expect(await run.send({ run_id: run.run_id, event: { kind: "retry_requested", unit: run.unit, worker: "builder_b" } }))
      .toMatchObject({ value: { kind: "committed" } });
    const second = await deliver((await run.action("builder_b")).action_id);
    expect(second.action.cause).toMatchObject({ kind: "assignment_round", round: round.id, retry: expect.any(String) });
    expect(second.engine_inputs.round_delivery).toBe(first.engine_inputs.round_delivery);
    expect(kbbl.sessions.size).toBe(1);
    expect([...kbbl.sessions.values()].flatMap(session => session.inputs.map(input => input.delivery_key)))
      .toEqual([round.id, selectDeliveryKey(second)]);
  } finally { kbbl.stop(); }
});

test("approval refuses while an assignment awaits update or verification", async () => {
  const run = await assigned();
  expect(await (await run.decide({ decision: "approve" })).text()).toContain("awaits update");
  await update(run, "builder_b", "updated");
  expect(await (await run.decide({ decision: "approve" })).text()).toContain("assessed work changed since it was read");
  await update(run, "builder_a", "updated");
  expect(await run.publish({ worker: "assessor", artifact: "assessment", subject: (await run.revision("part_a"))!.id, body: cleanAssessment }))
    .toMatchObject({ value: { kind: "committed" } });
  expect(await (await run.decide({ decision: "approve" })).text()).toContain("awaits verification");
  expect(await run.rows("authority.assessment_approval")).toEqual([]);
});

test("a returned round can be superseded, late updates preserve its identity, and verified work is approved", async () => {
  const run = await openReturnedAssessment(authority);
  expect(await (await run.decide({ decision: "approve" })).text()).toContain("needs further work");
  const target = (await run.revision("part_a"))!.id;
  const instruction = "Finish the correction.";
  expect((await run.authorize(run.item, target, instruction, ["builder_b"])).status).toBe(201);
  expect((await run.decide(dispatch(run.item, instruction, ["builder_b"]))).status).toBe(201);
  const round2 = (await run.rows("authority.assignment_round")).find(round => round.ordinal === 2)!;
  expect(round2.assignment_id).toBe(run.b.assignment_id);
  const kbbl = startStubKbbl(async () => "succeeded");
  try {
    const provider = createAgentProvider({ kbbl: new KbblClient({ base_url: kbbl.url, control_token: null }),
      publication_key: "test-publication-key", publish_base_url: "http://localhost", default_workdir: "/tmp" });
    const rounds = new Set([run.b.action_id, round2.action_id]);
    for (const intent of (await run.rows("authority.effect_intent")).filter(value => rounds.has(value.action_id))) {
      const instruction = intent.payload;
      const result = await provider.start(instruction);
      if (result.kind !== "acknowledged") throw new Error(JSON.stringify(result));
      const material = { task: instruction.engine_inputs.round_delivery! };
      await provider.observe(instruction, material, result.value.handle);
      await provider.observe(instruction, material, result.value.handle);
    }
    expect([...kbbl.sessions.values()].flatMap(session => session.inputs.map(input => input.delivery_key)).sort())
      .toEqual([run.b.id, round2.id].sort());
  } finally { kbbl.stop(); }
  await run.publish({ worker: "builder_b", by: run.late, artifact: "part_b", body: { text: "late" } });
  expect((await run.rows("authority.assignment_update")).some(row => row.round_id === round2.id)).toBe(false);
  await update(run, "builder_b", "final");
  const refused = await run.publish({ worker: "assessor", artifact: "assessment", subject: target,
    body: { ...cleanAssessment, checks: [{ round_id: run.b.id, outcome: "verified" }] } });
  expect(refused).toMatchObject({ value: { kind: "rejected", reason: expect.stringContaining("superseded or un-updated round") } });
  const publication = { worker: "assessor", artifact: "assessment", subject: target,
    predecessor: (await run.revision("assessment"))!.id, request_id: crypto.randomUUID(),
    body: { ...cleanAssessment, checks: [{ round_id: round2.id, outcome: "verified" }] } };
  expect(await run.publish(publication)).toMatchObject({ value: { kind: "committed" } });
  const facts = await run.rows("authority.assignment_verification");
  expect(await run.publish(publication)).toMatchObject({ value: { kind: "replayed" } });
  expect(await run.rows("authority.assignment_verification")).toEqual(facts);
  await run.end("assessor");
  expect(await run.rows("authority.assessment_approval")).toEqual([]);
  expect((await run.decide({ decision: "approve" })).status).toBe(201);
  expect(await run.counts()).toMatchObject({ assignments: 2, rounds: 3 });
});

test("rejecting a follow-up and approving creates no rounds or intents", async () => {
  const run = await openReturnedAssessment(authority);
  const before = await run.counts();
  expect(await run.rows("authority.assessment_approval")).toEqual([]);
  expect((await run.decide({ decision: "approve", dispositions: [{ kind: "reject_follow_up", assignment: run.b.assignment_id, reason: "The work is sufficient." }] })).status).toBe(201);
  expect(await run.counts()).toEqual(before);
  const status = await (await run.status()).json() as AssessmentStatus;
  expect(status.items.map(item => item.item)).toEqual([run.item]);
  expect(status.items[0].assignments.map(entry => entry.progress).sort()).toEqual(["accepted_by_operator", "assessor_verified"]);
});

test("approval can reject two follow-ups on the same item independently", async () => {
  const run = await openReturnedAssessment(authority, "needs_further_work");
  const before = await run.counts();
  const dispositions = [run.a, run.b].map(round => ({
    kind: "reject_follow_up" as const, assignment: round.assignment_id, reason: "The work is sufficient.",
  }));
  expect(await (await run.decide({ decision: "approve", dispositions: [dispositions[0], dispositions[0]] })).text())
    .toContain("has multiple dispositions");
  expect(await run.rows("authority.feedback_rejection")).toEqual([]);
  expect((await run.decide({ decision: "approve", dispositions })).status).toBe(201);
  expect(await run.counts()).toEqual(before);
  expect((await run.rows("authority.feedback_rejection")).map(row => row.assignment_id).sort())
    .toEqual([run.a.assignment_id, run.b.assignment_id].sort());
});

test("reassessing without a proposal carries the item, and a superseded assessment cannot be approved", async () => {
  const run = await openReturnedAssessment(authority);
  const old = (await run.rows("authority.feedback_item"))[0].proposal_revision_id;
  expect(await (await run.decide({ decision: "approve", target: old! })).text()).toContain("not the latest assessment revision");
  expect(await run.rows("authority.assessment_feedback")).toEqual(expect.arrayContaining([expect.objectContaining({
    feedback_item_id: run.item, assessment_revision_id: (await run.revision("assessment"))!.id, association: "carried",
  })]));
  expect(await run.counts()).toMatchObject({ assignments: 2, rounds: 2 });
});

test("finding-only assessments create no proposed feedback or assignments", async () => {
  const run = await withoutProposal();
  expect(await run.rows("authority.feedback_item")).toEqual([]);
  expect(await run.counts()).toMatchObject({ assignments: 0, rounds: 0 });
});

test("rejecting a proposal and approving preserves a fail verdict and replays atomically", async () => {
  const run = await assessed(sampleProposal);
  const [{ id: item }] = await run.rows("authority.feedback_item");
  const before = await run.counts();
  const command = { decision: "approve", dispositions: [{ kind: "reject" as const, item, reason: "Out of scope." }] };
  const request_id = crypto.randomUUID();
  expect((await run.decide(command, request_id)).status).toBe(201);
  const rejections = await run.rows("authority.feedback_rejection");
  const approvals = await run.rows("authority.assessment_approval");
  expect((await run.decide(command, request_id)).status).toBe(200);
  expect(await run.rows("authority.feedback_rejection")).toEqual(rejections);
  expect(await run.rows("authority.assessment_approval")).toEqual(approvals);
  expect(await run.revision("assessment")).toMatchObject({ body: { verdict: "fail" } });
  expect(await run.counts()).toEqual(before);
});

for (const key of ["payload", "rework_feedback"]) test(`assessment operations refuse obsolete ${key} input`, async () => {
  const run = await assessed();
  expect(await (await run.decide({ decision: "approve", [key]: {} })).text()).toContain("assessment decisions take dispositions only");
  expect(await run.rows("authority.assessment_approval")).toEqual([]);
});

test("receipt failure rolls back assignments, rounds and intents and a retry commits them once", async () => {
  const run = await assessed(sampleProposal);
  const [{ id: item }] = await run.rows("authority.feedback_item");
  await run.authorize(item, run.subject, sampleProposal.instruction, ["builder_a", "builder_b"]);
  const before = await run.counts();
  await sql`CREATE FUNCTION authority.fail_feedback_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$`.execute(authority.db);
  await sql`CREATE TRIGGER fail_feedback_receipt BEFORE INSERT ON authority.ingress_receipt FOR EACH ROW WHEN (NEW.ingress_id = 'operator:assessment-fault') EXECUTE FUNCTION authority.fail_feedback_receipt()`.execute(authority.db);
  try {
    expect((await run.decide(dispatch(item), "assessment-fault")).status).toBe(500);
    expect(await run.counts()).toEqual(before);
  } finally {
    await sql`DROP TRIGGER fail_feedback_receipt ON authority.ingress_receipt`.execute(authority.db);
    await sql`DROP FUNCTION authority.fail_feedback_receipt()`.execute(authority.db);
  }
  expect((await run.decide(dispatch(item), "assessment-fault")).status).toBe(201);
  expect(await run.counts()).toEqual({ assignments: 2, rounds: 2, intents: before.intents + 2 });
});




test("operator-created feedback is replayable and direct correction dispatches it", async () => {
  const run = await assessed();
  const request = { request_id: crypto.randomUUID(), instruction: "Direct correction", citation: { revision_id: run.subject, pointer: "/text" } };
  const response = await run.request("POST", "/assessments/assessment/feedback", request);
  expect(response.status).toBe(201);
  const { item_id } = await response.json() as { readonly item_id: string };
  expect(await (await run.request("POST", "/assessments/assessment/feedback", request)).json()).toEqual({ item_id });
  expect(await run.rows("authority.feedback_item")).toMatchObject([{ id: item_id, origin: "operator" }]);
  expect((await run.authorize(item_id, run.subject, request.instruction, ["builder_b"])).status).toBe(201);
  const before = await run.counts();
  const command = { ...dispatch(item_id, request.instruction, ["builder_b"]), decision: "correct" };
  expect((await run.decide(command)).status).toBe(201);
  expect(await run.counts()).toEqual({ assignments: 1, rounds: 1, intents: before.intents + 1 });
});

test("validator diagnostics and blocker answers never create assignments", async () => {
  const run = await prepared();
  expect(await run.publish({ worker: "assessor", artifact: "assessment", body: { ...cleanAssessment, verdict: "fail" }, subject: run.subject }))
    .toMatchObject({ value: { kind: "committed" } });
  const invalid = (await run.revision("assessment"))!.id;
  expect(await authority.db.selectFrom("authority.review_decision").select("review").where("target_revision_id", "=", invalid).execute())
    .toEqual([{ review: "engine:validator" }]);
  expect(await run.rows("authority.assessment_feedback")).toEqual([]);
  const blocker = await run.publish({ worker: "assessor", artifact: "blocker", body: { text: "Choose the output." } });
  expect(blocker).toMatchObject({ value: { kind: "committed" } });
  const target = (await run.revision("blocker"))!.id;
  expect((await run.request("POST", "/reviews/blocker_review/decide", { request_id: crypto.randomUUID(), decision: "clarify",
    target, payload: { answer: "Keep the published work." } })).status).toBe(201);
  expect(await run.counts()).toMatchObject({ assignments: 0, rounds: 0 });
});
