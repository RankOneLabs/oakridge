import type * as schema from "@agentclientprotocol/sdk";
import { expect, test } from "bun:test";
import { resolveRequestedModel } from "./config-option-resolver";

// Model options captured 2026-11-21 from claude-agent-acp 0.76.0 driving the
// installed CLI 2.1.330. A new session offers the `fable` alias; the same
// agent reloading a session whose transcript ran on Fable 5.2 offers the
// concrete `claude-fable-5-2` in its place. Both carry the name "Fable 5.2".
const NEW_SESSION_MODELS: schema.SessionConfigSelectOption[] = [
  { value: "default", name: "Default (recommended)" },
  { value: "opus", name: "Opus 5.5" },
  { value: "fable", name: "Fable 5.2" },
  { value: "sonnet", name: "Sonnet 5.5" },
  { value: "haiku", name: "Haiku 5.5" },
  { value: "claude-fable-5-1", name: "Fable 5.1" },
  { value: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
  { value: "claude-sonnet-5", name: "Sonnet 5" },
  { value: "claude-opus-5", name: "Opus 5" },
  { value: "claude-fable-5", name: "Fable 5" },
  { value: "claude-opus-4-8", name: "Opus 4.8" },
  { value: "claude-opus-4-7", name: "Opus 4.7" },
  { value: "claude-opus-4-6", name: "Opus 4.6" },
  { value: "claude-sonnet-4-6", name: "Sonnet 4.6" },
];

const RELOADED_FABLE_SESSION_MODELS: schema.SessionConfigSelectOption[] = NEW_SESSION_MODELS.map((option) =>
  option.value === "fable" ? { value: "claude-fable-5-2", name: "Fable 5.2" } : option,
);

function modelSelector(options: schema.SessionConfigSelectOption[]): schema.SessionConfigOption[] {
  return [{ type: "select", id: "model", name: "Model", category: "model", currentValue: "opus", options }];
}

test("a new session's alias resolves exactly and reports the agent's name for it", () => {
  const resolved = resolveRequestedModel(modelSelector(NEW_SESSION_MODELS), { requested_model: "fable", applied_model_name: null });
  expect(resolved).toEqual({ ok: true, value: { configId: "model", valueId: "fable", valueName: "Fable 5.2", match: { kind: "exact" } } });
});

test("a reloaded session finds its model by the recorded name when the alias is gone", () => {
  const resolved = resolveRequestedModel(modelSelector(RELOADED_FABLE_SESSION_MODELS), { requested_model: "fable", applied_model_name: "Fable 5.2" });
  expect(resolved).toEqual({ ok: true, value: { configId: "model", valueId: "claude-fable-5-2", valueName: "Fable 5.2", match: { kind: "applied_name_matched", appliedName: "Fable 5.2" } } });
});

test("a reloaded session with no recorded name cannot resolve the missing alias", () => {
  const resolved = resolveRequestedModel(modelSelector(RELOADED_FABLE_SESSION_MODELS), { requested_model: "fable", applied_model_name: null });
  expect(resolved.ok ? null : resolved.error.code).toBe("requested_model_unsupported");
});

test("a recorded name on the requested id itself is an exact match", () => {
  const resolved = resolveRequestedModel(modelSelector(NEW_SESSION_MODELS), { requested_model: "fable", applied_model_name: "Fable 5.2" });
  expect(resolved.ok ? resolved.value?.match : null).toEqual({ kind: "exact" });
});

test("the recorded name wins over an alias that has moved to a newer model", () => {
  const moved = [...RELOADED_FABLE_SESSION_MODELS, { value: "fable", name: "Fable 5.3" }];
  const resolved = resolveRequestedModel(modelSelector(moved), { requested_model: "fable", applied_model_name: "Fable 5.2" });
  expect(resolved.ok ? resolved.value?.valueId : null).toBe("claude-fable-5-2");
});

test("a recorded name carried by two options falls back to the requested id", () => {
  const ambiguous = [...NEW_SESSION_MODELS, { value: "claude-fable-5-2", name: "Fable 5.2" }];
  const resolved = resolveRequestedModel(modelSelector(ambiguous), { requested_model: "fable", applied_model_name: "Fable 5.2" });
  expect(resolved.ok ? resolved.value?.valueId : null).toBe("fable");
});

test("a miss on both the id and the recorded name names both in the error", () => {
  const resolved = resolveRequestedModel(modelSelector(RELOADED_FABLE_SESSION_MODELS), { requested_model: "fable", applied_model_name: "Fable 9" });
  expect(resolved.ok ? null : resolved.error.detail).toBe('no option matching "fable" in config option "model", and no single option is named "Fable 9"');
});

test("nothing requested resolves to null even with a recorded name", () => {
  const resolved = resolveRequestedModel(modelSelector(NEW_SESSION_MODELS), { requested_model: null, applied_model_name: "Fable 5.2" });
  expect(resolved).toEqual({ ok: true, value: null });
});
