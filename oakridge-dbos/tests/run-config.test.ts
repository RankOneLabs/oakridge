import { expect, test } from "bun:test";
import { parseRunConfig, selectWorkerSessionSettings } from "../src/domain/run-config";
import { parseLaunchRequest } from "../src/http/ingress";

const planner = { harness: "claude-code", model: "opus", effort: "high" };
const builder = { harness: "codex", model: "gpt-6-sol", effort: "high" };

test("worker settings are independent within a stage", () => {
  const config = { sessions: { review: { drafter: builder, checker: planner } } };
  expect([selectWorkerSessionSettings(config, { stage: "review", worker: "drafter" }, null),
    selectWorkerSessionSettings(config, { stage: "review", worker: "checker" }, null)])
    .toEqual([builder, planner]);
});

test("a dotted stage name cannot be mistaken for another stage's worker", () => {
  const config = { sessions: { "review.writer": { checker: planner }, review: { writer: builder } } };
  expect([selectWorkerSessionSettings(config, { stage: "review.writer", worker: "checker" }, null),
    selectWorkerSessionSettings(config, { stage: "review", worker: "writer" }, null)])
    .toEqual([planner, builder]);
});

test("an unconfigured worker uses its declared runtime", () => {
  expect(selectWorkerSessionSettings({ sessions: { cohort: { builder } } },
    { stage: "cohort", worker: "assessor" }, { harness: "codex", model: "gpt-5.5" }))
    .toEqual({ harness: "codex", model: "gpt-5.5", effort: null });
});

test("a worker without a choice or declared runtime uses the adapter default", () => {
  expect(selectWorkerSessionSettings(null, { stage: "cohort", worker: "builder" }, null)).toBeNull();
});

test("the parser rejects stage-wide settings and malformed worker settings", () => {
  expect([parseRunConfig({ sessions: { cohort: builder } }),
    parseRunConfig({ sessions: { cohort: { builder: { harness: "codex" } } } }),
    parseRunConfig({ sessions: [] })]).toEqual([null, null, null]);
});

test("an omitted effort reads as none", () => {
  expect(parseRunConfig({ sessions: { planning: { planner: { harness: "codex", model: "gpt-5.5" } } } }))
    .toEqual({ sessions: { planning: { planner: { harness: "codex", model: "gpt-5.5", effort: null } } } });
});

test("a launch with malformed config is malformed; one without config has none", () => {
  const base = { request_id: "r1", digest: "d", input: {} };
  const bad = parseLaunchRequest({ ...base, config: { sessions: { planning: { planner: {} } } } });
  const none = parseLaunchRequest(base);
  expect([bad.ok, none.ok ? none.value.config : "failed"]).toEqual([false, null]);
});

test("a stage named like an Object.prototype member has no inherited settings", () => {
  expect(selectWorkerSessionSettings({ sessions: { planning: { planner } } },
    { stage: "constructor", worker: "planner" }, { harness: "codex", model: "gpt-5.5" }))
    .toEqual({ harness: "codex", model: "gpt-5.5", effort: null });
});
