import { expect, test } from "bun:test";
import type { RevisionState } from "../src/core-client/core-types";
import { selectEffectInstruction, type EffectInstruction, type RunWorkerAction } from "../src/domain/effect-instruction";
import { renderSessionPreamble, renderSessionTask, renderSharedTaskDelivery, renderTemplate, selectSessionTaskContext, type SessionTaskContext } from "../src/effects/session-prompt";
import { sampleWorkflow } from "./authority-fixture";

const unit = "run-1/document";
const r1: RevisionState = { id: `${unit}:draft:1`, unit, seq: 1, artifact: "draft", body: { title: "T", body: "long" }, by: "a1" };
const revise: RunWorkerAction = { kind: "run_worker", unit, worker: "writer", mode: { kind: "revise" }, cause: { kind: "changes_requested", decision: `${unit}:d1` } };
function writerInstruction(input: { readonly action: RunWorkerAction; readonly fresh?: boolean }): EffectInstruction {
  const workflow = sampleWorkflow("review-loop");
  const writer = workflow.stages.document!.workers.writer!;
  const source = input.fresh && writer.kind === "agent"
    ? { ...workflow, stages: { document: { ...workflow.stages.document!, workers: { ...workflow.stages.document!.workers, writer: { ...writer, session: "fresh" as const } } } } }
    : workflow;
  const is_revise = input.action.mode.kind === "revise";
  const selected = selectEffectInstruction({ run_id: "run-1" as import("../src/domain/primitives").RunId, workflow: source, stage: "document", config: null, action: input.action, seq: 0,
    prompts: { "review-loop/write.md": "a".repeat(64), "review-loop/revise.md": "b".repeat(64) },
    resolved: { action_id: "a2", inputs: { topic: "Oakridge", critique: null }, feedback: is_revise
      ? [{ id: `${unit}:d1`, review: "draft_review", decision: "request_changes", target: r1.id, payload: { feedback: "shorter" } }] : [],
      ...(is_revise ? { previous: r1 } : {}) } });
  if (!selected.ok) throw new Error(selected.error.detail);
  return selected.value;
}
const context = (overrides: Partial<SessionTaskContext> = {}): SessionTaskContext => ({
  prompt_text: "Revise the draft about {{topic}} using the requested feedback: {{feedback}}.", handoff_text: null,
  latest: [{ artifact: "draft", revision_id: r1.id, body: r1.body }],
  previous_attempt: { mode: { kind: "initial" }, status: { kind: "succeeded" } }, ...overrides });

test("a template renders text as written, absence as none and structure as JSON, leaving unknown keys", () => {
  expect(renderTemplate("{{ a }}|{{b}}|{{c}}|{{d}}", { a: "text", b: null, c: { k: 1 } })).toBe('text|none|{\n  "k": 1\n}|{{d}}');
});

test("a revise task carries the review form's feedback and the revision to publish over, and no handoff under resume", () => {
  const task = renderSessionTask(writerInstruction({ action: revise }), context());
  expect([task.includes("shorter"), task.includes("Oakridge"), task.includes(`current revision \`${r1.id}\``), task.includes("## Handoff")])
    .toEqual([true, true, true, false]);
});

test("a fresh revise starts with the handoff block: latest revisions, feedback and how the last attempt ended", () => {
  const task = renderSessionTask(writerInstruction({ action: revise, fresh: true }),
    context({ previous_attempt: { mode: { kind: "initial" }, status: { kind: "failed", code: "no_output", detail: "nothing published" } } }));
  const handoff = task.slice(0, task.indexOf("Revise the draft"));
  expect([handoff.startsWith("## Handoff"), handoff.includes(r1.id), handoff.includes("shorter"),
    handoff.includes("failed (no_output): nothing published")]).toEqual([true, true, true, true]);
});

test("a fresh worker's first attempt has nothing to hand off", () => {
  const initial: RunWorkerAction = { ...revise, mode: { kind: "initial" }, cause: { kind: "missing" } };
  const task = renderSessionTask(writerInstruction({ action: initial, fresh: true }),
    context({ prompt_text: "Write about {{topic}}", latest: [{ artifact: "draft", revision_id: null, body: null }], previous_attempt: null }));
  expect([task.includes("## Handoff"), task.includes("no revision yet")]).toEqual([false, true]);
});

test("a handoff template words the handoff from its fields and the declared inputs", () => {
  const task = renderSessionTask(writerInstruction({ action: revise, fresh: true }),
    context({ handoff_text: "Picking up {{topic}}: last time {{previous_attempt}}; artifacts {{artifacts}}" }));
  expect([task.startsWith("Picking up Oakridge: last time"), task.includes(r1.id), task.includes("## Handoff")]).toEqual([true, true, false]);
});

test("the task context takes each artifact's latest revision and the most recent earlier attempt", () => {
  const selected = selectSessionTaskContext(writerInstruction({ action: revise }), {
    earlier_attempts: [{ mode: { kind: "initial" }, status: { kind: "succeeded" } }, { mode: { kind: "revise" }, status: { kind: "failed", code: "x", detail: "y" } }],
    latest: [{ id: r1.id, artifact: "draft", body: r1.body }],
  }, { prompt_text: "p", handoff_text: null });
  expect({ latest: selected.latest, previous: selected.previous_attempt }).toEqual({
    latest: [{ artifact: "draft", revision_id: r1.id, body: r1.body }],
    previous: { mode: { kind: "revise" }, status: { kind: "failed", code: "x", detail: "y" } } });
});

test("the preamble's publication block names each artifact's endpoint and schema and the session's secret", () => {
  const instruction = writerInstruction({ action: revise });
  const creates = instruction.worker.kind === "agent" ? instruction.worker.creates : [];
  const preamble = renderSessionPreamble({ run_id: "run-1", unit, worker: "writer", creates, schemas: { tag: "ident" },
    publish_base_url: "http://oakridge.test/", secret: "s3cret" });
  expect([preamble.includes("endpoint: http://oakridge.test/api/runs/run-1/units/run-1%2Fdocument/artifacts/draft"),
    preamble.includes('schema: {"title":"text","body":"text"}'), preamble.includes('- `tag`: "ident"'), preamble.includes("Your publication secret: s3cret")])
    .toEqual([true, true, true, true]);
});

test("a shared session's stable preamble leaves each brief's endpoint in its task", () => {
  const first = writerInstruction({ action: { ...revise, unit: "run-1/briefs/a" } });
  const second = writerInstruction({ action: { ...revise, unit: "run-1/briefs/b" } });
  if (first.worker.kind !== "agent" || second.worker.kind !== "agent") throw new Error("writer is an agent");
  const a: EffectInstruction = { ...first, worker: { ...first.worker, session: "shared", shared_session_unit: "run-1/briefs" } };
  const b: EffectInstruction = { ...second, worker: { ...second.worker, session: "shared", shared_session_unit: "run-1/briefs" } };
  const preamble = renderSessionPreamble({ run_id: "run-1", unit: "run-1/briefs", worker: "writer", creates: first.worker.creates,
    schemas: {}, publish_base_url: "http://oakridge.test", secret: "s", shared: true });
  expect([preamble.includes("Prefix each task's endpoint with http://oakridge.test"), preamble.includes("/briefs/a"),
    renderSessionTask(a, context()).includes("run-1%2Fbriefs%2Fa"), renderSessionTask(b, context()).includes("run-1%2Fbriefs%2Fb")])
    .toEqual([true, false, true, true]);
  const delivered = renderSharedTaskDelivery(a, renderSessionTask(a, context()), { publish_base_url: "http://oakridge.test", secret: "session-secret" });
  expect([delivered.includes("Authorization: Bearer session-secret"),
    delivered.includes("PUT http://oakridge.test/api/runs/run-1/units/run-1%2Fbriefs%2Fa/artifacts/draft"),
    delivered.includes("Do not use the backend publication key")]).toEqual([true, true, true]);
});

test("feedback history renders every review identity in recorded order", () => {
  const base = writerInstruction({ action: revise });
  const feedback = [
    { id: `${unit}:d1`, review: "assessment_review", decision: "request_build_changes", target: r1.id, payload: { feedback: "first" } },
    { id: `${unit}:d2`, review: "pr_closed", decision: "closed", target: r1.id, payload: { feedback: "second" } },
  ];
  const task = renderSessionTask({ ...base, engine_inputs: { ...base.engine_inputs, feedback } }, context());
  expect([task.indexOf("assessment_review") < task.indexOf("pr_closed"), task.includes("request_build_changes"), task.includes("second")])
    .toEqual([true, true, true]);
});
