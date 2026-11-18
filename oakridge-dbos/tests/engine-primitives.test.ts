import { afterAll, expect, test } from "bun:test";
import { CoreClient, compileWorkflow, type CompileInput, type CompiledAgainst } from "../src/core-client/client";
import type { Event, Incoming, StepResult, StepSnapshot, Workflow, Writer } from "../src/core-client/core-types";
import { selectCommitPlan } from "../src/storage/commit";
import type { RunId } from "../src/domain/primitives";
import { renderModePrompt, renderSessionPreamble, renderSessionTask, withReviewHistory } from "../src/effects/session-prompt";
import { selectRunUnitView, selectRunView } from "../src/projections/run-view";
import type { RunRead } from "../src/storage/read-store";
import { ingressResponse } from "../src/http/ingress";

const started = CoreClient.start();
if (!started.ok) throw new Error(started.error.detail.detail);
const core = started.value;
afterAll(() => core.close());
const OPERATOR: Writer = { kind: "operator", subject: "operator:test" };
const prompts = { "initial.md": "Write", "revise.md": "Revise using {{feedback}} and {{review_history}}", "review.md": "Review" };
const workflow = (stage: "brief" | "build"): Workflow => ({ workflow: `blocker_${stage}`, input: {},
  run: { units: { a: { stage }, b: { stage, after: ["a"] } }, outcome: {} },
  stages: { [stage]: { input: {}, artifacts: { result: { kind: "record", schema: { findings: "list(text)", text: "text" } } },
    workers: { writer: { kind: "agent", prompts: { initial: "initial.md", revise: "revise.md" }, inputs: {}, produces: ["result"] } },
    reviews: { result_review: { of: "result", by: "operator", prompt: "review.md", decisions: {
      accept: { label: "Accept", effect: "approve", when: { check: "len(result.findings) == 0", reason: "Resolve findings" } },
      request_changes: { label: "Fix", effect: "request_changes", on: "result", payload: { entries: "list(text)", builder_feedback: "text" }, feedback_field: "builder_feedback" },
    } } }, done_when: "approved(result)", outcome: {} } },
});

class Run {
  readonly source: CompileInput["workflow"];
  readonly compiled: CompiledAgainst;
  state: StepSnapshot = { run: { id: "run", root: "run" }, units: [], attempts: [], revisions: [], decisions: [], retry_events: [] };
  result: StepResult = { snapshot: this.state, wanted: [], reviews: [], blocked: [] };
  readonly intents: RunRead["intents"][number][] = [];
  constructor(source: CompileInput["workflow"], compiled: CompiledAgainst) { this.source = source; this.compiled = compiled; }
  static async create(stage: "brief" | "build", has_revise = true): Promise<Run> {
    const source = workflow(stage);
    if (!has_revise) {
      const worker = source.stages[stage]?.workers.writer;
      if (worker?.kind === "agent") delete (worker.prompts as { revise?: string }).revise;
      // A historical worker with no revise prompt also had no request-change review.
      const review = source.stages[stage]?.reviews?.result_review;
      if (review) delete (review.decisions as { request_changes?: unknown }).request_changes;
    }
    const compiled = await compileWorkflow(core, { workflow: source, prompts });
    if (!compiled.ok) throw new Error(compiled.error.detail);
    const run = new Run(source, compiled.value);
    await run.apply({ kind: "launched", input: {} });
    return run;
  }
  async apply(event: Event) {
    const incoming: Incoming = { event, writer: event.kind === "revision_published" ? { kind: "executor", attempt: event.by ?? "none" } : OPERATOR, ingress_id: crypto.randomUUID() };
    const stepped = await core.request("step", { workflow_digest: this.compiled.digest, snapshot: this.state, incoming });
    if (!stepped.ok || stepped.value.kind !== "stepped") throw new Error(JSON.stringify(stepped));
    const result = stepped.value.value;
    const plan = selectCommitPlan(this.state, result, {
      request: { run_id: "run" as RunId, ingress_id: null, event, writer: incoming.writer }, event_id: crypto.randomUUID(), digest: "request-digest",
      unit_id: "run/a", source: this.source, parsed_workflow: this.compiled.workflow,
      prompts, config: null, intent_actions: this.intents.map((intent) => intent.action_id),
      review_rows: this.state.units.map((unit) => ({ id: unit.id, review_prompts: {}, blocked_reason: null })),
      prompt_texts: new Map(Object.entries(prompts)), logged_wanted: new Map(),
    });
    if (!plan.ok) throw new Error(plan.error.detail);
    this.intents.push(...plan.value.intents.map((intent) => ({ action_id: intent.action_id, seq: intent.seq, payload: intent.instruction })));
    this.result = result;
    this.state = result.snapshot;
    return plan.value;
  }
  latest(artifact: string) { return this.state.revisions.filter((revision) => revision.unit === "run/a" && revision.artifact === artifact).at(-1); }
  attempt() { const attempt = this.state.attempts.filter((attempt) => attempt.unit === "run/a").at(-1); if (!attempt) throw new Error("attempt absent"); return attempt; }
  async publish(artifact: string, body: unknown) {
    return this.apply({ kind: "revision_published", unit: "run/a", artifact, body, predecessor: this.latest(artifact)?.id ?? null, subject: null, by: this.attempt().action_id });
  }
  async answer(decision: "clarify" | "discuss" | "override") {
    const target = this.latest("blocker")?.id;
    if (!target) throw new Error("blocker absent");
    return this.apply({ kind: "operator_decided", unit: "run/a", review: "blocker_review", decision, target, payload: { answer: "Use the revised contract" } });
  }
  read(): RunRead {
    const date = (index: number) => new Date(1_700_000_000_000 + index * 1000);
    return { run: { id: "run", root_unit_id: "run", definition_id: "definition", config: {}, input: {}, created_at: date(0), archived_at: null },
      definition: { workflow: this.source, parsed_workflow: this.compiled.workflow },
      units: this.state.units.map((unit) => ({ ...unit, run_id: "run", parent_id: unit.parent, stage: unit.kind.kind === "stage" ? unit.kind.stage : null,
        blocked_reason: this.result.blocked.find((block) => block.unit === unit.id)?.reason ?? null,
        review_prompts: Object.fromEntries(this.result.reviews.filter((review) => review.unit === unit.id).map((review) => [review.review, { target: review.target, decisions: review.decisions, prompt: "Review" }])) })),
      revisions: this.state.revisions.map((revision, index) => ({ ...revision, run_id: "run", unit_id: revision.unit, by_id: revision.by,
        predecessor_id: revision.predecessor, created_at: date(index * 2 + 1) })),
      decisions: this.state.decisions.flatMap((decision, index) => decision.kind === "review" ? [{ ...decision, run_id: "run", unit_id: decision.unit,
        target_revision_id: decision.target, effect: decision.effect.kind, actor: OPERATOR, created_at: date(index * 2 + 2) }] : []),
      dependencies: [], attempts: [], intents: this.intents, retries: [], stalls: [], faults: [], latest_events: [],
    } as unknown as RunRead;
  }
}

for (const stage of ["brief", "build"] as const) {
  test(`${stage}: a blocker-only attempt succeeds, parks the unit and starts no dependant`, async () => {
    const run = await Run.create(stage);
    const plan = await run.publish("blocker", { text: "Ambiguous inputs", suggested_choices: ["A", "B"] });
    expect(plan.delta.changed_attempts[0]?.status.kind).toBe("succeeded");
    expect(plan.intents).toHaveLength(0);
    expect(run.state.units.find((unit) => unit.id === "run/b")?.status.kind).toBe("not_started");
    expect(run.result.blocked.find((block) => block.unit === "run/a")?.reason.kind).toBe("blocker");
    await run.apply({ kind: "worker_ended", action: run.attempt().action_id, result: { kind: "succeeded" } });
    expect(run.attempt().status.kind).toBe("succeeded");
  });
}

test("blocker answers use the review-decision path and reach the same worker prompt", async () => {
  const run = await Run.create("brief");
  await run.publish("blocker", { text: "Which contract?" });
  const plan = await run.answer("clarify");
  expect(plan.delta.created_decisions[0]).toMatchObject({ kind: "review", review: "blocker_review", decision: "clarify", payload: { answer: "Use the revised contract" } });
  const instruction = plan.intents[0]?.instruction;
  if (!instruction) throw new Error("resume instruction absent");
  const task = renderSessionTask(instruction, { prompt_text: prompts["revise.md"], handoff_text: null, latest: [], previous_attempt: null });
  expect([instruction.action.worker, instruction.action.mode.kind, task.includes("Use the revised contract")]).toEqual(["writer", "revise", true]);
});

test("a historical agent without a revise prompt can resume its blocker", async () => {
  const run = await Run.create("brief", false);
  await run.publish("blocker", { text: "Clarify" });
  const plan = await run.answer("clarify");
  const instruction = plan.intents[0]?.instruction;
  expect(instruction?.worker.kind === "agent" ? instruction.worker.prompt.path : null).toBe("initial.md");
});

test("blocker history and attention follow discuss, revised blocker, override and normal publication", async () => {
  const run = await Run.create("build");
  await run.publish("blocker", { text: "First question" });
  await run.answer("discuss");
  await run.publish("blocker", { text: "Second question", suggested_choices: ["Choice"] });
  const view = selectRunUnitView(run.read(), "run/a");
  expect(view?.blocker?.history.map((entry) => entry.kind)).toEqual(["revision", "decision", "revision"]);
  expect(view?.blocker?.latest.text).toBe("Second question");
  expect(view?.blocker?.decisions[0]?.actor).toEqual(OPERATOR);
  expect(view?.blocker?.available_decisions.map((decision) => decision.decision)).toEqual(["clarify", "discuss", "override"]);
  expect(selectRunView(run.read()).open_blockers).toHaveLength(1);
  expect(view?.attention).toMatchObject({ kind: "waiting", reason: "worker blocked: needs an operator answer" });
  await run.answer("override");
  await run.publish("result", { findings: [], text: "Implemented" });
  expect(selectRunView(run.read()).open_blockers).toEqual([]);
});

test("a guarded decision is disabled with its reason and its refusal writes no review decision", async () => {
  const run = await Run.create("build");
  await run.publish("result", { findings: ["blocking"], text: "Review" });
  await run.apply({ kind: "worker_ended", action: run.attempt().action_id, result: { kind: "succeeded" } });
  const view = selectRunUnitView(run.read(), "run/a");
  expect(view?.decisions.find((decision) => decision.key === "accept")).toMatchObject({ is_available: false, disabled_reason: "Resolve findings" });
  const target = run.latest("result")?.id;
  if (!target) throw new Error("result absent");
  const response = await core.request("step", { workflow_digest: run.compiled.digest, snapshot: run.state,
    incoming: { event: { kind: "operator_decided", unit: "run/a", review: "result_review", decision: "accept", target, payload: {} }, writer: OPERATOR, ingress_id: null } });
  if (response.ok || response.error.kind !== "domain") throw new Error("expected guarded rejection");
  const http = ingressResponse("run" as RunId, { ok: true, value: { kind: "rejected", reason: response.error.detail.detail } });
  expect([http.status, await http.text(), run.state.decisions.length]).toEqual([409, expect.stringContaining("Resolve findings"), 0]);
});

test("every preamble includes the blocker endpoint, schema and exact alternative-publication instruction", () => {
  const preamble = renderSessionPreamble({ run_id: "run", unit: "run/a", worker: "writer", creates: [{ key: "result", schema: "text" }], schemas: {}, publish_base_url: "http://oakridge.test", secret: "test-secret" });
  expect(preamble).toContain("endpoint: http://oakridge.test/api/runs/run/units/run%2Fa/artifacts/blocker");
  expect(preamble).toContain("suggested_choices");
  expect(preamble).toContain("If the inputs are contradictory, unimplementable or ambiguous in a way only the operator can settle, publish a `blocker` instead of guessing; a published blocker ends the task.");
});

test("review_history and latest field-only feedback render independently in the worker template", async () => {
  const run = await Run.create("build");
  const instruction = run.intents[0]?.payload;
  if (!instruction) throw new Error("initial instruction absent");
  const history = [{ id: "d1", review: "assessment_review", decision: "changes", target: "r1", payload: { entries: ["full disposition"], builder_feedback: "Fix X" } }];
  const resolved = { action_id: "action", inputs: {}, feedback: [{ ...history[0]!, payload: { feedback: "Fix X" } }], review_history: history };
  const enriched = withReviewHistory({ ...instruction, engine_inputs: { ...instruction.engine_inputs, feedback: resolved.feedback } }, resolved);
  const rendered = renderModePrompt(enriched, "{{feedback}}\nHISTORY\n{{review_history}}");
  expect(rendered.split("HISTORY")[0]).not.toContain("full disposition");
  expect(rendered.split("HISTORY")[1]).toContain("full disposition");
});


test("templated agent workers receive the implicit blocker schema in their stored publishing instructions", async () => {
  const source = workflow("build");
  const stage = source.stages.build;
  const writer = stage?.workers.writer;
  if (!stage || writer?.kind !== "agent") throw new Error("writer absent");
  const authored = { ...source, workers: { shared: writer }, stages: { build: { ...stage, workers: { writer: { template: "shared" } } } } };
  const compiled = await compileWorkflow(core, { workflow: authored, prompts });
  if (!compiled.ok) throw new Error(compiled.error.detail);
  const run = new Run(authored, compiled.value);
  await run.apply({ kind: "launched", input: {} });
  const instruction = run.intents[0]?.payload;
  expect(instruction?.worker.kind === "agent" && instruction.worker.creates.some((artifact) => artifact.key === "blocker")).toBe(true);
});
