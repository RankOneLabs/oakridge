import { expect, test } from "bun:test";
import { parseRunConfig, selectWorkerSessionSettings } from "../src/domain/run-config";
import { parseLaunchRequest } from "../src/http/ingress";

const planner = { harness: "claude-code", model: "opus", effort: "high" };
const builder = { harness: "codex", model: "gpt-6-sol", effort: "high" };

test("worker settings are independent within a stage", () => {
  const config = { sessions: { review: { drafter: builder, checker: planner } }, grading_enabled: false };
  expect([selectWorkerSessionSettings(config, { stage: "review", worker: "drafter" }, null),
    selectWorkerSessionSettings(config, { stage: "review", worker: "checker" }, null)])
    .toEqual([builder, planner]);
});

test("a dotted stage name cannot be mistaken for another stage's worker", () => {
  const config = { sessions: { "review.writer": { checker: planner }, review: { writer: builder } }, grading_enabled: false };
  expect([selectWorkerSessionSettings(config, { stage: "review.writer", worker: "checker" }, null),
    selectWorkerSessionSettings(config, { stage: "review", worker: "writer" }, null)])
    .toEqual([planner, builder]);
});

test("an unconfigured worker uses its declared runtime", () => {
  expect(selectWorkerSessionSettings({ sessions: { cohort: { builder } }, grading_enabled: false },
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
    .toEqual({ sessions: { planning: { planner: { harness: "codex", model: "gpt-5.5", effort: null } } }, grading_enabled: false });
});

test("a launch with malformed config is malformed; one without config has none", () => {
  const base = { request_id: "r1", definition_id: "0".repeat(64), input: {} };
  const bad = parseLaunchRequest({ ...base, config: { sessions: { planning: { planner: {} } } } });
  const none = parseLaunchRequest(base);
  expect([bad.ok, none.ok ? none.value.config : "failed"]).toEqual([false, null]);
});

test("a stage named like an Object.prototype member has no inherited settings", () => {
  expect(selectWorkerSessionSettings({ sessions: { planning: { planner } }, grading_enabled: false },
    { stage: "constructor", worker: "planner" }, { harness: "codex", model: "gpt-5.5" }))
    .toEqual({ harness: "codex", model: "gpt-5.5", effort: null });
});

test("automatic grading is off when a config does not choose it", () => {
  expect([parseRunConfig({ sessions: {} }), parseRunConfig({})]).toEqual([
    { sessions: {}, grading_enabled: false }, { sessions: {}, grading_enabled: false }]);
});

test("an explicit grading choice is kept exactly", () => {
  expect([parseRunConfig({ grading_enabled: true }), parseRunConfig({ grading_enabled: false, sessions: { cohort: { builder } } })])
    .toEqual([{ sessions: {}, grading_enabled: true }, { sessions: { cohort: { builder } }, grading_enabled: false }]);
});

test("a config without sessions keeps every worker on its declared runtime", () => {
  const config = parseRunConfig({ grading_enabled: true });
  expect(selectWorkerSessionSettings(config, { stage: "cohort", worker: "builder" }, { harness: "codex", model: "gpt-5.5" }))
    .toEqual({ harness: "codex", model: "gpt-5.5", effort: null });
});

test("a grading choice that is not a boolean is malformed, never enabled", () => {
  expect(["true", 1, null, {}].map((grading_enabled) => parseRunConfig({ grading_enabled }))).toEqual([null, null, null, null]);
  const base = { request_id: "r1", definition_id: "0".repeat(64), input: {} };
  expect(parseLaunchRequest({ ...base, config: { grading_enabled: "yes" } }).ok).toBe(false);
});

test("a launch request carries the parsed grading choice with or without sessions", () => {
  const base = { request_id: "r1", definition_id: "0".repeat(64), input: {} };
  const on = parseLaunchRequest({ ...base, config: { grading_enabled: true } });
  const sessionsOnly = parseLaunchRequest({ ...base, config: { sessions: { cohort: { builder } } } });
  expect([on.ok ? on.value.config : "failed", sessionsOnly.ok ? sessionsOnly.value.config : "failed"]).toEqual([
    { sessions: {}, grading_enabled: true }, { sessions: { cohort: { builder } }, grading_enabled: false }]);
});
