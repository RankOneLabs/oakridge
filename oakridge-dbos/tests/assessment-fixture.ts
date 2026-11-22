import { expect } from "bun:test";
import { sql, type Selectable } from "kysely";
import type { DB } from "../src/storage/db-types";
import { Hono } from "hono";
import type { AssessmentDecisionCommand, AssignmentVerification, FeedbackProposal, RevisionState, Workflow } from "../src/core-client/core-types";
import { controlTokenMiddleware, operatorCredentialCheck } from "../src/http/control-auth";
import { installIngress } from "../src/http/ingress";
import { installReadModels } from "../src/http/read-models";
import { launch, submitter, type Authority } from "./authority-fixture";
import { commitTestDefinition } from "./committed-fixture";

const write = "review-loop/write.md";
const revise = "review-loop/revise.md";
const review = "review-loop/critique.md";
const editor = "review-loop/editor.md";
const editorPrompt = { path: editor, content: "Review the current assessment." };
const workerInputs = { topic: '"assignment"' };
export const assessmentWorkflow = {
  workflow: "assignment", input: {},
  schemas: { observation: { id: "ident", fix: "optional(feedback_proposal)" } },
  run: { units: { work: { stage: "work" } }, outcome: {} },
  stages: { work: {
    input: {}, outcome: {}, done_when: "approved(assessment)",
    artifacts: {
      part_a: { kind: "record", schema: { text: "text" } }, part_b: { kind: "record", schema: { text: "text" } },
      report: { kind: "record", schema: "text" },
      assessment: { kind: "assessment", schema: { observations: "list(observation)", checks: "list(assignment_verification)", verdict: "enum(pass, fail)" },
        edit_policy: { kind: "frozen_when_accepted" },
        validate: [{ check: 'assessment.verdict == "pass" or len(assessment.observations) > 0', message: "Fail needs a finding" }] },
    },
    workers: {
      builder_a: { kind: "agent", inputs: workerInputs, prompts: { initial: write, revise }, produces: ["part_a"] },
      builder_b: { kind: "agent", inputs: workerInputs, prompts: { initial: write, revise }, produces: ["part_b"] },
      watch: { kind: "code", operation: "value.publish", inputs: { value: '"watch"' }, produces: ["report"] },
      assessor: { kind: "agent", inputs: workerInputs, prompts: { review, revise }, evaluates: "part_a", produces: ["assessment"] },
    },
    reviews: { assessment_review: { by: "operator", of: "assessment", prompt: editor, decisions: {
      approve: { effect: "approve", operation: "approve_assessment", label: "Approve" },
      send: { effect: "request_changes", on: "part_a", operation: "dispatch_feedback", label: "Send" },
      correct: { effect: "request_changes", on: "part_a", operation: "direct_correction", label: "Correct" },
    } } },
  } },
} satisfies Workflow;

type Observation = { readonly id: string; readonly fix?: FeedbackProposal };
export interface AssessmentBody { readonly observations: readonly Observation[]; readonly checks: readonly AssignmentVerification[]; readonly verdict: "pass" | "fail" }

export const cleanAssessment: AssessmentBody = { observations: [], checks: [], verdict: "pass" };
export const sampleProposal: FeedbackProposal = { key: "fix", instruction: "Correct the fixture." };

export async function openAssessmentRun(authority: Authority, source: Workflow = assessmentWorkflow, input: unknown = {}) {
  const { definition_id } = await commitTestDefinition({ source, prompt_edit: editorPrompt });
  const { run_id, result } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input });
  if (!result.ok || result.value.kind !== "committed") throw new Error(JSON.stringify(result));
  const unit = `${run_id}/work`;
  const send = submitter(authority);
  const deps = { ...authority, wake: () => undefined, is_operator_request: operatorCredentialCheck("operator-test") };
  const app = new Hono();
  app.use("*", controlTokenMiddleware("operator-test"));
  installIngress(app, deps);
  installReadModels(app, deps);
  const endpoint = `/api/runs/${run_id}/units/${encodeURIComponent(unit)}`;
  const request = (method: string, route: string, body?: unknown, credential = "operator-test") => app.request(`${endpoint}${route}`, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const action = async (worker: string, targetUnit = unit) => await authority.db.selectFrom("authority.attempt").selectAll()
    .where("run_id", "=", run_id).where("unit_id", "=", targetUnit).where("worker", "=", worker)
    .orderBy("created_at", "desc").orderBy("seq", "desc").executeTakeFirstOrThrow();
  const revision = async (artifact: string, targetUnit = unit) => await authority.db.selectFrom("authority.artifact_revision")
    .selectAll().where("run_id", "=", run_id).where("unit_id", "=", targetUnit).where("artifact", "=", artifact)
    .orderBy("seq", "desc").executeTakeFirst();
  interface Publication {
    readonly worker: string; readonly artifact: string; readonly body: unknown; readonly subject?: RevisionState["id"] | null;
    readonly request_id?: string; readonly by?: string; readonly predecessor?: string | null; readonly unit?: string;
  }
  const publish = async (input: Publication) => {
    const targetUnit = input.unit ?? unit;
    const current = await action(input.worker, targetUnit);
    const by = input.by ?? current.action_id;
    const predecessor = input.predecessor !== undefined ? input.predecessor : (await revision(input.artifact, targetUnit))?.id ?? null;
    return await send({ run_id, ingress_id: input.request_id, writer: { kind: "session", session: input.worker, attempt: by },
      event: { kind: "revision_published", unit: targetUnit, artifact: input.artifact, body: input.body, predecessor, subject: input.subject ?? null, by: { action: by, seq: input.by ? 1 : current.seq } } });
  };
  const end = async (worker: string, targetUnit = unit) => {
    const by = (await action(worker, targetUnit)).action_id;
    return await send({ run_id, writer: { kind: "executor", attempt: by },
      event: { kind: "worker_ended", action: by, result: { kind: "succeeded" } } });
  };
  const decide = async (command: Partial<AssessmentDecisionCommand> & { readonly decision: string; readonly [key: string]: unknown }, request_id: string = crypto.randomUUID()) => {
    const current = await revision("assessment");
    return await request("POST", "/reviews/assessment_review/decide", {
      request_id, target: current?.id, assessed_revision: current?.subject, dispositions: [], ...command,
    });
  };
  const authorize = (item: string, target_revision: string, instruction: string, recipients: readonly string[], request_id = crypto.randomUUID(), credential?: string) =>
    request("POST", `/feedback/${item}/authorizations`, { request_id, item, target_revision, instruction, recipients }, credential);
  const status = () => request("GET", "/assessments/assessment/status");
  const rows = <Table extends "authority.feedback_item" | "authority.assignment_round" | "authority.feedback_assignment" |
    "authority.assignment_update" | "authority.assignment_verification" | "authority.assessment_approval" | "authority.feedback_rejection" |
    "authority.dispatch_authorization" | "authority.effect_intent" | "authority.assessment_feedback">(table: Table) =>
    sql<Selectable<DB[Table]>>`select * from ${sql.table(table)} where run_id = ${run_id}`.execute(authority.db).then(result => result.rows);
  const counts = async () => {
    const [assignments, rounds, intents] = await Promise.all([rows("authority.feedback_assignment"), rows("authority.assignment_round"), rows("authority.effect_intent")]);
    return { assignments: assignments.length, rounds: rounds.length, intents: intents.length };
  };
  return { run_id, unit, send, action, revision, publish, end, decide, authorize, request, status, rows, counts };
}

/** One item with two recipients, one verified and one returned for another round. */
export async function openReturnedAssessment(authority: Authority, firstOutcome: AssignmentVerification["outcome"] = "verified") {
  const run = await openAssessmentRun(authority);
  const publishWork = async (worker: "builder_a" | "builder_b", text: string) => {
    expect(await run.publish({ worker, artifact: worker === "builder_a" ? "part_a" : "part_b", body: { text } }))
      .toMatchObject({ value: { kind: "committed" } });
    await run.end(worker);
  };
  await publishWork("builder_a", "a");
  await publishWork("builder_b", "b");
  const subject = (await run.revision("part_a"))!.id;
  expect(await run.publish({ worker: "assessor", artifact: "assessment", subject,
    body: { ...cleanAssessment, observations: [{ id: "finding", fix: sampleProposal }], verdict: "fail" } }))
    .toMatchObject({ value: { kind: "committed" } });
  await run.end("assessor");
  const [{ id: item }] = await run.rows("authority.feedback_item");
  const { instruction } = sampleProposal;
  const recipients = ["builder_a", "builder_b"];
  expect((await run.authorize(item, subject, instruction, recipients)).status).toBe(201);
  expect((await run.decide({ decision: "send", dispositions: [{ kind: "dispatch", item, instruction, recipients }] })).status).toBe(201);
  const [first, other] = await Promise.all([run.action("builder_a"), run.action("builder_b")]);
  const rounds = await run.rows("authority.assignment_round");
  const a = rounds.find(round => round.action_id === first.action_id)!;
  const b = rounds.find(round => round.action_id === other.action_id)!;
  await publishWork("builder_a", "updated A");
  await publishWork("builder_b", "updated B");
  expect(await run.publish({ worker: "assessor", artifact: "assessment", subject: (await run.revision("part_a"))!.id,
    body: { ...cleanAssessment, checks: [{ round_id: a.id, outcome: firstOutcome }, { round_id: b.id, outcome: "needs_further_work" }] } }))
    .toMatchObject({ value: { kind: "committed" } });
  await run.end("assessor");
  return { ...run, item, a, b, late: other.action_id };
}
