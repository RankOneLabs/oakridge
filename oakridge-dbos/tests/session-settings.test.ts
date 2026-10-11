import { expect, test } from "bun:test";
import { resolveSessionSettings, type SessionPolicy, type SessionScopeSelector, type SessionSettingsContext } from "../src/domain/session-settings";

const context: SessionSettingsContext = {
  stage_key: "implementation", cohort_key: "c01", worker_key: "build", action_key: "initial",
  worker_defaults: [
    { runtime: "claude-code", model: "sonnet", effort: "medium" },
    { runtime: "codex", model: "gpt-6-sol", effort: "low" },
  ],
};
const run: SessionScopeSelector = { kind: "run" };
const stage: SessionScopeSelector = { kind: "stage", stage_key: "implementation" };
const cohort: SessionScopeSelector = { kind: "cohort", stage_key: "implementation", cohort_key: "c01" };
const worker: SessionScopeSelector = { kind: "stage_worker", stage_key: "implementation", worker_key: "build" };
const action: SessionScopeSelector = { kind: "stage_worker_action", stage_key: "implementation", worker_key: "build", action_key: "initial" };
const entry = (selector: SessionScopeSelector, settings: { runtime?: "codex" | "claude-code"; model?: string; effort?: string }) =>
  ({ selector, settings: { runtime: settings.runtime ?? null, model: settings.model ?? null, effort: settings.effort ?? null } });
const policy = (...entries: SessionPolicy["entries"]): SessionPolicy => ({ version: 3, entries });

test.each([
  { selector: run, model: "opus" },
  { selector: stage, model: "haiku" },
  { selector: cohort, model: "opus" },
  { selector: worker, model: "haiku" },
  { selector: action, model: "opus" },
])("$selector.kind setting overrides only model and retains other fields", ({ selector, model }) => {
  const result = resolveSessionSettings(policy(entry(selector, { model })), context);
  expect(result).toEqual({ ok: true, value: {
    runtime: "claude-code", model, effort: "medium",
    provenance: { runtime: { kind: "bundle_default" }, model: { kind: "policy", selector }, effort: { kind: "bundle_default" } },
  } });
});

test("specificity wins even when entries are supplied out of order", () => {
  const result = resolveSessionSettings(policy(entry(action, { effort: "high" }), entry(run, { model: "haiku" }), entry(stage, { model: "opus" }), entry(worker, { model: "sonnet" })), context);
  expect(result).toEqual({ ok: true, value: {
    runtime: "claude-code", model: "sonnet", effort: "high",
    provenance: { runtime: { kind: "bundle_default" }, model: { kind: "policy", selector: worker }, effort: { kind: "policy", selector: action } },
  } });
});

test("a runtime change uses the bundle role default for the new runtime", () => {
  const result = resolveSessionSettings(policy(entry(run, { model: "opus" }), entry(worker, { runtime: "codex" })), context);
  expect(result).toEqual({ ok: true, value: {
    runtime: "codex", model: "gpt-6-sol", effort: "low",
    provenance: { runtime: { kind: "policy", selector: worker }, model: { kind: "bundle_default" }, effort: { kind: "bundle_default" } },
  } });
});

test("an explicit model outside the resolved runtime is rejected with field and value", () => {
  const result = resolveSessionSettings(policy(entry(run, { runtime: "codex", model: "opus" })), context);
  expect(result).toMatchObject({ ok: false, error: { operation: "resolve_session_settings", field: "model", value: "opus" } });
});

test("an explicit effort outside the resolved runtime is rejected", () => {
  const result = resolveSessionSettings(policy(entry(action, { effort: "ultra" })), context);
  expect(result).toMatchObject({ ok: false, error: { field: "effort", value: "ultra" } });
});

test("nonmatching cohort does not override the worker", () => {
  const result = resolveSessionSettings(policy(entry({ kind: "cohort", stage_key: "implementation", cohort_key: "c02" }, { model: "opus" })), context);
  expect(result.ok && result.value.model).toBe("sonnet");
});
