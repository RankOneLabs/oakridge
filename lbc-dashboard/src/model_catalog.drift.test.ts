/**
 * Drift guard: the generated PWA mirror must match the kbbl canonical catalog.
 *
 * If this test fails, regenerate:
 *   bun run lbc-dashboard/scripts/generate_model_catalog.ts
 * then commit the updated lbc-dashboard/src/generated/model_catalog.ts.
 */
import { describe, expect, test } from "bun:test";

import { LBC_STUDY_MODEL_CATALOG as CANONICAL } from "../../kbbl/core/model-catalog";
import {
  LBC_STUDY_MODEL_CATALOG as GENERATED,
  modelMetaFor,
  modelLabelFromCatalog,
} from "./generated/model_catalog";

describe("model_catalog drift", () => {
  test("generated catalog has the same number of models as canonical", () => {
    expect(GENERATED.length).toBe(CANONICAL.length);
  });

  test("generated catalog entries match canonical field-for-field", () => {
    for (let i = 0; i < CANONICAL.length; i++) {
      const c = CANONICAL[i];
      const g = GENERATED[i];
      expect(g.id).toBe(c.id);
      expect(g.label).toBe(c.label);
      expect(g.provider).toBe(c.provider);
      expect(g.order).toBe(c.order);
      expect(g.inForm).toBe(c.inForm);
    }
  });

  test("modelMetaFor resolves claude-sonnet-4-5", () => {
    const m = modelMetaFor("claude-sonnet-4-5");
    expect(m).toBeDefined();
    expect(m?.label).toBe("Claude Sonnet 4.5");
    expect(m?.provider).toBe("Anthropic");
    expect(m?.inForm).toBe(true);
  });

  test("modelLabelFromCatalog falls back to raw id for unknown models", () => {
    expect(modelLabelFromCatalog("unknown-model-xyz")).toBe("unknown-model-xyz");
  });

  test("form models are a strict subset of all models", () => {
    const formModels = GENERATED.filter((m) => m.inForm);
    expect(formModels.length).toBeGreaterThan(0);
    expect(formModels.length).toBeLessThan(GENERATED.length);
    for (const m of formModels) {
      expect(GENERATED.some((g) => g.id === m.id)).toBe(true);
    }
  });

  test("catalog contains all expected model ids", () => {
    const ids = GENERATED.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-sonnet-4-5");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("gpt-5.4");
    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).toContain("gpt-5.3-codex-spark");
    expect(ids).toContain("gpt-5");
    expect(ids).toContain("gpt-5-mini");
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).toContain("gemini-2.5-flash");
  });
});
