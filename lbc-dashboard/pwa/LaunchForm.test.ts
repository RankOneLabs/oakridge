/**
 * Unit tests for the buildRunSpec pure helper. The form UI is verified
 * manually via `bun run dev:pwa` — no component-test harness exists in
 * this PWA.
 */
import { describe, expect, test } from "bun:test";

import { buildRunSpec } from "./components/organisms/LaunchForm";
import type { FormState } from "./components/organisms/LaunchForm";

const base: FormState = {
  target: "prose_substrate_thesis",
  checkedModels: new Set(["claude-sonnet-4-5"]),
  extraModels: [],
  conditionKind: "single_agent",
  n: 1,
  should_grade: true,
};

describe("buildRunSpec", () => {
  test("accepts valid single_agent spec", () => {
    const r = buildRunSpec(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.condition.kind).toBe("single_agent");
      expect(r.spec.model_pool).toEqual(["claude-sonnet-4-5"]);
      expect(r.spec.grade).toBe(true);
    }
  });

  test("rejects empty model_pool", () => {
    const r = buildRunSpec({ ...base, checkedModels: new Set(), extraModels: [] });
    expect(r.ok).toBe(false);
  });

  test("rejects ensemble_multi_round with n=1", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_multi_round", n: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/n >= 2/);
    }
  });

  test("accepts ensemble_multi_round with n=2", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_multi_round", n: 2 });
    expect(r.ok).toBe(true);
  });

  test("accepts ensemble_single_round with n=3", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_single_round", n: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.condition.n).toBe(3);
    }
  });

  test("rejects ensemble_single_round with n=1", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_single_round", n: 1 });
    expect(r.ok).toBe(false);
  });

  test("accepts ensemble_incremental with n=1", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_incremental", n: 1 });
    expect(r.ok).toBe(true);
  });

  test("includes extra models after known models in pool", () => {
    const r = buildRunSpec({
      ...base,
      checkedModels: new Set(["claude-sonnet-4-5"]),
      extraModels: ["openrouter/my-custom-model"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.model_pool).toEqual([
        "claude-sonnet-4-5",
        "openrouter/my-custom-model",
      ]);
    }
  });

  test("known models appear in KNOWN_MODELS order regardless of check order", () => {
    // gpt-5 comes after haiku in KNOWN_MODELS; both checked.
    const r = buildRunSpec({
      ...base,
      checkedModels: new Set(["gpt-5", "claude-haiku-4-5"]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The helper sorts checked known models by KNOWN_MODELS position.
      expect(r.spec.model_pool).toEqual(["claude-haiku-4-5", "gpt-5"]);
    }
  });

  test("includes opus 4.8 as a known model", () => {
    const r = buildRunSpec({
      ...base,
      checkedModels: new Set(["claude-opus-4-8"]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.model_pool).toEqual(["claude-opus-4-8"]);
    }
  });

  test("rejects invalid target", () => {
    const r = buildRunSpec({ ...base, target: "not_a_target" });
    expect(r.ok).toBe(false);
  });

  test("rejects single_agent with n=2", () => {
    const r = buildRunSpec({ ...base, conditionKind: "single_agent", n: 2 });
    expect(r.ok).toBe(false);
  });
});
