import { expect, test } from "bun:test";
import { parseRunConfig, selectSessionSettings, selectWorkerSessionSettings } from "../src/domain/run-config";
import { parseLaunchRequest } from "../src/http/ingress";

const planner = { harness: "claude-code", model: "opus", effort: "high" };
const builder = { harness: "codex", model: "gpt-6-sol", effort: "high" };

test("worker settings are independent for any workflow with multiple agent workers", () => {
  const config = { sessions: { "review.drafter": builder, "review.checker": planner } };
  expect([selectWorkerSessionSettings(config, { workflow: "review", stage: "review", worker: "drafter" }, null),
    selectWorkerSessionSettings(config, { workflow: "review", stage: "review", worker: "checker" }, null)])
    .toEqual([builder, planner]);
});

test("a development assessor uses its worker choice while the builder keeps the cohort choice", () => {
  const config = { sessions: { cohort: builder, "cohort.assessor": planner } };
  expect([selectWorkerSessionSettings(config, { workflow: "development", stage: "cohort", worker: "builder" }, null),
    selectWorkerSessionSettings(config, { workflow: "development", stage: "cohort", worker: "assessor" }, null)])
    .toEqual([builder, planner]);
});

test("a cohort assessor in an existing development run inherits its planner choice", () => {
  const config = { sessions: { cohort: builder, planning: planner } };
  expect(selectWorkerSessionSettings(config, { workflow: "development", stage: "cohort", worker: "assessor" }, null))
    .toEqual(planner);
});

test("the development assessor fallback does not change another workflow's cohort worker", () => {
  const config = { sessions: { cohort: builder, planning: planner } };
  expect(selectWorkerSessionSettings(config, { workflow: "other", stage: "cohort", worker: "assessor" }, null))
    .toEqual(builder);
});

test("a run's settings for a stage win over the worker's declared runtime", () => {
  expect(selectSessionSettings({ sessions: { planning: planner } }, "planning", { harness: "codex", model: "gpt-5.5" })).toEqual(planner);
});

test("a stage the config does not name keeps its worker's declared runtime, with the runtime's own effort", () => {
  expect(selectSessionSettings({ sessions: { planning: planner } }, "implementation", { harness: "codex", model: "gpt-5.5" }))
    .toEqual({ harness: "codex", model: "gpt-5.5", effort: null });
});

test("with neither, the session starts with kbbl's default", () => {
  expect(selectSessionSettings(null, "implementation", null)).toBeNull();
});

test("a config entry without a harness and model is refused, not partly applied", () => {
  expect([parseRunConfig({ sessions: { planning: { harness: "codex" } } }), parseRunConfig({ sessions: [] })]).toEqual([null, null]);
});

test("an omitted effort reads as none", () => {
  expect(parseRunConfig({ sessions: { planning: { harness: "codex", model: "gpt-5.5" } } }))
    .toEqual({ sessions: { planning: { harness: "codex", model: "gpt-5.5", effort: null } } });
});

test("a launch with a malformed config is malformed; one without a config has none", () => {
  const base = { request_id: "r1", digest: "d", input: {} };
  const bad = parseLaunchRequest({ ...base, config: { sessions: { planning: {} } } });
  const none = parseLaunchRequest(base);
  expect([bad.ok, none.ok ? none.value.config : "failed"]).toEqual([false, null]);
});

test("a stage named like an Object.prototype member has no settings chosen for it", () => {
  expect(selectSessionSettings({ sessions: { planning: planner } }, "constructor", { harness: "codex", model: "gpt-5.5" }))
    .toEqual({ harness: "codex", model: "gpt-5.5", effort: null });
});
