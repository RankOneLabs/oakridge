import { expect, test } from "bun:test";
import type { ResolvedRunWorker } from "../src/core-client/core-types";
import { decodeEffectInstruction, DEFAULT_MAX_START_ATTEMPTS, DEFAULT_PROVIDER_DEADLINE_MS, selectEffectInstruction, selectEverySeconds,
  selectReferencedSchemas, selectResolvedSchema, selectSessionKey, type RunWorkerAction } from "../src/domain/effect-instruction";
import { bounded, resolveObserve, resolveStart, resolveStop } from "../src/effects/outcomes";
import { sampleWorkflow } from "./authority-fixture";

const unit = "run-1/document";
const action: RunWorkerAction = { kind: "run_worker", unit, worker: "writer", mode: { kind: "initial" }, cause: { kind: "missing" } };
const resolved: ResolvedRunWorker = { action_id: `${unit}:writer:Initial:Missing`, inputs: { topic: "Oakridge", critique: null } };
const prompts = { "review-loop/write.md": "a".repeat(64) };
const select = (overrides: Partial<Parameters<typeof selectEffectInstruction>[0]> = {}) =>
  selectEffectInstruction({ run_id: "run-1", workflow: sampleWorkflow("review-loop"), prompts, stage: "document", config: null, action, seq: 1, resolved, ...overrides });

test("an agent instruction carries its pinned prompt, session key, inputs and default budgets", () => {
  const instruction = select();
  expect(instruction.ok ? instruction.value : null).toEqual({ version: 1, run_id: "run-1", action, attempt: { action_id: resolved.action_id, seq: 1 },
    worker: { kind: "agent", session: "resume", session_key: selectSessionKey(action, resolved.action_id, "resume"),
      prompt: { path: "review-loop/write.md", digest: "a".repeat(64) }, handoff: null, settings: null,
      creates: [{ key: "draft", schema: { title: "text", body: "text" } }], schemas: {} },
    inputs: { topic: "Oakridge", critique: null }, engine_inputs: { previous: null, feedback: null, subject: null }, workspace: null,
    deadline_ms: DEFAULT_PROVIDER_DEADLINE_MS, max_start_attempts: DEFAULT_MAX_START_ATTEMPTS });
});

test("a fresh worker pins its handoff template; a resume worker never does", () => {
  const workflow = sampleWorkflow("review-loop");
  const writer = workflow.stages.document!.workers.writer!;
  if (writer.kind !== "agent") throw new Error("writer is an agent");
  const fresh = { ...workflow, stages: { document: { ...workflow.stages.document!,
    workers: { ...workflow.stages.document!.workers, writer: { ...writer, session: "fresh" as const, prompts: { ...writer.prompts, handoff: "review-loop/handoff.md" } } } } } };
  const pinned = { ...prompts, "review-loop/handoff.md": "b".repeat(64) };
  const selected = select({ workflow: fresh, prompts: pinned });
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
