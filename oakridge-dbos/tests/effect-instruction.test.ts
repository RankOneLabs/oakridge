import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { BLOCKER_REVIEW, BLOCKER_SCHEMA, type ResolvedRunWorker, type Workflow } from "../src/core-client/core-types";
import { decodeEffectInstruction, DEFAULT_MAX_START_ATTEMPTS, DEFAULT_PROVIDER_DEADLINE_MS, selectEffectInstruction, selectEverySeconds,
  selectReferencedSchemas, selectResolvedSchema, selectSessionKey, type RunWorkerAction } from "../src/domain/effect-instruction";
import { bounded, resolveObserve, resolveStart, resolveStop } from "../src/effects/outcomes";
import { compiledFixture, sampleWorkflow } from "./authority-fixture";
import type { ActionId, RunId } from "../src/domain/primitives";

const workflow = sampleWorkflow("review-loop");
const parsed_workflow = await compiledFixture(workflow);
const development = JSON.parse(readFileSync(new URL("../../workflow-core/fixtures/bundles/development.json", import.meta.url), "utf8")) as Workflow;
const parsed_development = await compiledFixture(development);
const parsed_document = parsed_workflow.stages.document!;
const parsed_writer = parsed_document.workers.writer!;
if (parsed_writer.kind !== "agent") throw new Error("writer is an agent");
type AgentWorker = typeof parsed_writer;
const withWriter = (writer: AgentWorker) => ({ ...parsed_workflow, stages: { ...parsed_workflow.stages,
  document: { ...parsed_document, workers: { ...parsed_document.workers, writer } } } });

const unit = "run-1/document";
const action: RunWorkerAction = { kind: "run_worker", unit, worker: "writer", mode: { kind: "initial" }, cause: { kind: "missing" } };
const resolved: ResolvedRunWorker = { action_id: `${unit}:writer:Initial:Missing`, inputs: { topic: "Oakridge", critique: null }, feedback: [], prompt: "review-loop/write.md" };
const prompts = { "review-loop/write.md": "a".repeat(64) };
const select = (overrides: Partial<Parameters<typeof selectEffectInstruction>[0]> = {}) =>
  selectEffectInstruction({ run_id: "run-1" as RunId, workflow, parsed_workflow, prompts, stage: "document", config: null, action, seq: 1, resolved, ...overrides });

test("an agent instruction carries its pinned prompt, session key, inputs and default budgets", () => {
  const instruction = select();
  expect(instruction.ok ? instruction.value : null).toEqual({ version: 1, run_id: "run-1" as RunId, action,
    attempt: { action_id: resolved.action_id as ActionId, seq: 1 },
    worker: { kind: "agent", session: "resume", session_key: selectSessionKey(action, resolved.action_id, "resume"),
      prompt: { path: "review-loop/write.md", digest: "a".repeat(64) }, handoff: null, settings: null,
      creates: [{ key: "draft", schema: { title: "text", body: "text" } }, { key: "blocker", schema: BLOCKER_SCHEMA }], schemas: {} },
    input_provenance: { status: "unresolved" }, inputs: { topic: "Oakridge", critique: null }, engine_inputs: { previous: null, feedback: [], subject: null }, workspace: null,
    deadline_ms: DEFAULT_PROVIDER_DEADLINE_MS, max_start_attempts: DEFAULT_MAX_START_ATTEMPTS });
});

test("a cohort pins independent assessor and builder settings", () => {
  const config = { sessions: { cohort: { assessor: { harness: "claude-code", model: "opus", effort: "high" },
    builder: { harness: "codex", model: "gpt-6-sol", effort: "high" } } }, pr_integration: "gated-review" as const, pr_skill_digest: null, grading_enabled: false };
  const settingsFor = (worker: string) => {
    const selected = select({ workflow: development, parsed_workflow: parsed_development, config, stage: "cohort",
      prompts: { "development/assess.md": "a".repeat(64) }, resolved: { ...resolved, prompt: "development/assess.md" }, action: { ...action,
      unit: "run-1/implementation/theme", worker } });
    return selected.ok && selected.value.worker.kind === "agent" ? selected.value.worker.settings : null;
  };
  expect([settingsFor("assessor"), settingsFor("builder")]).toEqual([config.sessions.cohort.assessor, config.sessions.cohort.builder]);
});

test("a fresh worker pins its handoff template; a resume worker never does", () => {
  const fresh = withWriter({ ...parsed_writer, session: "fresh", prompts: { ...parsed_writer.prompts, handoff: "review-loop/handoff.md" } });
  const pinned = { ...prompts, "review-loop/handoff.md": "b".repeat(64) };
  const selected = select({ parsed_workflow: fresh, prompts: pinned });
  const resumed = select({ prompts: pinned });
  expect([selected.ok && selected.value.worker.kind === "agent" ? selected.value.worker.handoff : "refused",
    resumed.ok && resumed.value.worker.kind === "agent" ? resumed.value.worker.handoff : "refused"])
    .toEqual([{ path: "review-loop/handoff.md", digest: "b".repeat(64) }, null]);
});

test("a created artifact's schema resolves the named schemas it references", () => {
  expect(selectResolvedSchema({ plan: "plan_body", note: "list(text)" }, { plan_body: { title: "text", steps: "step_list" }, step_list: "list(text)" }))
    .toEqual({ plan: { title: "text", steps: "list(text)" }, note: "list(text)" });
});

test("the named schemas an artifact references inside compound types are carried, transitively", () => {
  expect(selectReferencedSchemas([{ items: "list(item)", note: "optional(text)" }],
    { item: { name: "text", tags: "list(tag)" }, tag: "ident", unused: "text" }))
    .toEqual({ item: { name: "text", tags: "list(tag)" }, tag: "ident" });
});

test("every is whole seconds, minutes or hours, and nothing else", () => {
  expect(["30s", "5m", "2h", "0s", "5", "1.5m", "10d"].map(selectEverySeconds)).toEqual([30, 300, 7200, null, null, null, null]);
});

test("a session key is one path segment: resume per unit and worker, fresh per action", () => {
  const resume = selectSessionKey(action, resolved.action_id, "resume");
  const fresh = selectSessionKey(action, resolved.action_id, "fresh");
  expect({ has_slash: [resume, fresh].some((key) => key.includes("/")), differs: resume !== fresh,
    same_for_revise: selectSessionKey({ ...action, mode: { kind: "revise" } }, "other", "resume") === resume })
    .toEqual({ has_slash: false, differs: true, same_for_revise: true });
});

test("a session key is fixed-length and slash-free however long the unit's path", () => {
  const long: RunWorkerAction = { ...action, unit: `run-1/work/${"k".repeat(400)}` };
  const keys = [selectSessionKey(long, `${long.unit}:writer:Initial:Missing`, "resume"), selectSessionKey(long, `${long.unit}:writer:Initial:Missing`, "fresh")];
  expect(keys.map((key) => [key.length <= 300, /^[a-z]+-[0-9a-f]{64}$/.test(key)])).toEqual([[true, true], [true, true]]);
});

test("a shared writer uses one session key for sibling collection units", () => {
  const shared = withWriter({ ...parsed_writer, session: "shared" });
  const first = { ...action, unit: "run-1/briefs/a" };
  const second = { ...action, unit: "run-1/briefs/b" };
  const a = select({ parsed_workflow: shared, action: first });
  const b = select({ parsed_workflow: shared, action: second });
  expect([a.ok && a.value.worker.kind === "agent" ? a.value.worker.session_key : null,
    b.ok && b.value.worker.kind === "agent" ? b.value.worker.session_key : null,
    a.ok && a.value.worker.kind === "agent" ? a.value.worker.shared_session_unit : null])
    .toEqual([selectSessionKey(first, resolved.action_id, "shared"), selectSessionKey(first, resolved.action_id, "shared"), "run-1/briefs"]);
  expect(select({ parsed_workflow: shared }).ok).toBe(false);
});

test("an unpinned prompt or an undeclared worker refuses the instruction", () => {
  const unpinned = select({ prompts: {} });
  const undeclared = select({ action: { ...action, worker: "ghost" } });
  expect([unpinned.ok ? null : unpinned.error.detail, undeclared.ok ? null : undeclared.error.detail])
    .toEqual(["prompt review-loop/write.md is not pinned", "worker ghost is not declared on stage document"]);
});

test("the decoder accepts what commit writes and refuses anything else", () => {
  const instruction = select();
  if (!instruction.ok) throw new Error("instruction not selected");
  const stored: unknown = JSON.parse(JSON.stringify(instruction.value));
  const refusals = [{ ...instruction.value, version: 2 }, { ...instruction.value, action: { ...action, kind: "start" } },
    { ...instruction.value, worker: { kind: "agent" } }, { ...instruction.value, max_start_attempts: 0 }, null]
    .map((value) => decodeEffectInstruction(value)).map((decoded) => decoded.ok);
  expect({ accepted: decodeEffectInstruction(stored).ok, refusals }).toEqual({ accepted: true, refusals: [false, false, false, false, false] });
});

test("a start resolves to started, refused with its code, or retry", () => {
  expect([
    resolveStart({ kind: "acknowledged", value: { handle: { kind: "kbbl_session", session_id: "sid" }, publication_secret_hash: "h" } }),
    resolveStart({ kind: "acknowledged", value: { handle: { kind: "kbbl_session" }, publication_secret_hash: "h" } }),
    resolveStart({ kind: "permanently_rejected", code: "start_rejected", detail: "later" }),
    resolveStart({ kind: "uncertain", detail: "timeout" }),
  ]).toEqual([
    { kind: "started", started: { handle: { kind: "kbbl_session", session_id: "sid" }, publication_secret_hash: "h" } },
    { kind: "retry", detail: "provider acknowledged a start without a valid handle" },
    { kind: "refused", failure: { kind: "failed", code: "start_rejected", detail: "later" } },
    { kind: "retry", detail: "timeout" },
  ]);
});

test("an observation that is malformed or refused fails the attempt; an unavailable one retries", () => {
  expect([
    resolveObserve({ kind: "acknowledged", value: { kind: "running" } }).kind,
    resolveObserve({ kind: "acknowledged", value: { kind: "terminal", result: { kind: "succeeded" } } }),
    resolveObserve({ kind: "acknowledged", value: { kind: "terminal" } }).kind,
    resolveObserve({ kind: "permanently_rejected", code: "gone", detail: "session gone" }),
    resolveObserve({ kind: "transiently_unavailable", detail: "down" }),
  ]).toEqual(["running", { kind: "ended", result: { kind: "succeeded" } }, "refused",
    { kind: "refused", failure: { kind: "failed", code: "gone", detail: "session gone" } },
    { kind: "retry", detail: "down" }]);
});

test("only a positive acknowledgement confirms a stop", () => {
  expect([resolveStop({ kind: "acknowledged", value: { stopped: true } }).kind, resolveStop({ kind: "acknowledged", value: {} }).kind,
    resolveStop({ kind: "uncertain", detail: "x" }).kind]).toEqual(["confirmed", "retry", "retry"]);
});

test("a provider call past its deadline is uncertain and aborted", async () => {
  const controller = new AbortController();
  const result = await bounded(new Promise<never>(() => undefined), 5, controller);
  expect([result.kind, controller.signal.aborted]).toEqual(["uncertain", true]);
});

test("a same-SHA replacement selects the declared assessor review prompt", () => {
  const build = { id: "run-1/cohort:build_result:2", unit: "run-1/cohort", artifact: "build_result", seq: 2, body: { head_sha: "same" } };
  const previous = { id: "run-1/cohort:assessment:1", unit: "run-1/cohort", artifact: "assessment", seq: 1, body: { head_sha: "same" }, subject: "run-1/cohort:build_result:1" };
  const reviewAction: RunWorkerAction = { kind: "run_worker", unit: "run-1/cohort", worker: "assessor", mode: { kind: "review" }, cause: { kind: "review_of", revision: build.id } };
  const selected = selectEffectInstruction({ run_id: "run-1" as RunId, workflow: development, parsed_workflow: parsed_development, stage: "cohort", config: null, action: reviewAction, seq: 1,
    prompts: { "development/assess.md": "a".repeat(64), "development/assess-revise.md": "b".repeat(64) },
    resolved: { action_id: "assess-new-build", prompt: "development/assess.md", inputs: {}, previous, subject: build, feedback: [] } });
  expect(selected.ok && selected.value.worker.kind === "agent" ? selected.value.worker.prompt.path : "refused")
    .toBe("development/assess.md");
  const reviseAction: RunWorkerAction = { ...reviewAction, mode: { kind: "revise" }, cause: { kind: "changes_requested", decision: "run-1/cohort:d3" } };
  const revised = selectEffectInstruction({ run_id: "run-1" as RunId, workflow: development, parsed_workflow: parsed_development, stage: "cohort", config: null, action: reviseAction, seq: 2,
    prompts: { "development/assess.md": "a".repeat(64), "development/assess-revise.md": "b".repeat(64) },
    resolved: { action_id: "revise-assessment", prompt: "development/assess-revise.md", inputs: {}, previous, subject: build, feedback: [] } });
  expect(revised.ok && revised.value.worker.kind === "agent" ? revised.value.worker.prompt.path : "refused")
    .toBe("development/assess-revise.md");
});

test("effect instructions freeze the core unit provenance", () => {
  const entries = [{ input: "brief", unit: "run/briefs/a", revision_id: "accepted" }];
  const instruction = select({ resolved: { ...resolved, input_provenance: entries } });
  expect(instruction.ok && instruction.value.input_provenance).toEqual({ status: "recorded", entries });
});


test("ordinary revision without a resolved prompt refuses the instruction", () => {
  const selected = select({ action: { ...action, mode: { kind: "revise" } }, resolved: { ...resolved, prompt: null } });
  expect(selected.ok ? null : selected.error.detail).toBe("agent writer has no revise prompt");
});

test("the development projection exposes the core's blocker decision labels", () => {
  const decisions = parsed_development.stages.cohort?.reviews?.[BLOCKER_REVIEW]?.decisions ?? {};
  expect(Object.fromEntries(Object.entries(decisions).map(([key, decision]) => [key, decision.label])))
    .toEqual({ clarify: "Clarify", discuss: "Discuss", override: "Override" });
});
