import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { createPromptTemplateLoader } from "../src/runtime/prompt-template";

describe("production prompt template loading", () => {
  const loader = createPromptTemplateLoader(resolve(import.meta.dir, "../../oakridge-core/prompts"));

  test("loads the seeded workflow path from the repository prompt root", async () => {
    const template = await loader.load("dev-flow/spec_analyzer_v2.md");
    expect(template.length).toBeGreaterThan(0);
  });

  test("rejects traversal outside the prompt root", async () => {
    await expect(loader.load("../../package.json")).rejects.toThrow("outside the configured prompt root");
  });
});
