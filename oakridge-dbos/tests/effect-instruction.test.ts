import { expect, test } from "bun:test";
import type { ResolvedRunWorker } from "../src/core-client/core-types";
import { decodeEffectInstruction, DEFAULT_MAX_START_ATTEMPTS, DEFAULT_PROVIDER_DEADLINE_MS, selectEffectInstruction, selectSessionKey,
  type RunWorkerAction } from "../src/domain/effect-instruction";
import { bounded, resolveObserve, resolveStart, resolveStop } from "../src/effects/outcomes";
import { sampleWorkflow } from "./authority-fixture";

const unit = "run-1/document";
const action: RunWorkerAction = { kind: "run_worker", unit, worker: "writer", mode: { kind: "initial" }, cause: { kind: "missing" } };
const resolved: ResolvedRunWorker = { action_id: `${unit}:writer:Initial:Missing`, inputs: { topic: "Oakridge", critique: null } };
const prompts = { "review-loop/write.md": "a".repeat(64) };
const select = (overrides: Partial<Parameters<typeof selectEffectInstruction>[0]> = {}) =>
  selectEffectInstruction({ workflow: sampleWorkflow("review-loop"), prompts, stage: "document", action, seq: 1, resolved, ...overrides });

test("an agent instruction carries its pinned prompt, session key, inputs and default budgets", () => {
  const instruction = select();
  expect(instruction.ok ? instruction.value : null).toEqual({ version: 1, action, attempt: { action_id: resolved.action_id, seq: 1 },
    worker: { kind: "agent", session: "resume", session_key: selectSessionKey(action, resolved.action_id, "resume"),
      prompt: { path: "review-loop/write.md", digest: "a".repeat(64) }, runtime: null },
    inputs: { topic: "Oakridge", critique: null }, engine_inputs: { previous: null, feedback: null, subject: null }, workspace: null,
    deadline_ms: DEFAULT_PROVIDER_DEADLINE_MS, max_start_attempts: DEFAULT_MAX_START_ATTEMPTS });
});

test("a session key is one path segment: resume per unit and worker, fresh per action", () => {
  const resume = selectSessionKey(action, resolved.action_id, "resume");
  const fresh = selectSessionKey(action, resolved.action_id, "fresh");
  expect({ has_slash: [resume, fresh].some((key) => key.includes("/")), differs: resume !== fresh,
    same_for_revise: selectSessionKey({ ...action, mode: { kind: "revise" } }, "other", "resume") === resume })
    .toEqual({ has_slash: false, differs: true, same_for_revise: true });
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
    resolveStart({ kind: "acknowledged", value: { kind: "kbbl_session", session_id: "sid" } }),
    resolveStart({ kind: "acknowledged", value: { kind: "kbbl_session" } }),
    resolveStart({ kind: "permanently_rejected", code: "provider_not_ported", detail: "later" }),
    resolveStart({ kind: "uncertain", detail: "timeout" }),
  ]).toEqual([
    { kind: "started", handle: { kind: "kbbl_session", session_id: "sid" } },
    { kind: "retry", detail: "provider acknowledged a start without a valid handle" },
    { kind: "refused", failure: { kind: "failed", code: "provider_not_ported", detail: "later" } },
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
    { kind: "retry", detail: "down", is_unavailable: true }]);
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
