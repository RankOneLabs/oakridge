import { describe, expect, test } from "bun:test";
import { resolve, sep } from "node:path";

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

  test("loads a path beneath a filesystem root ending in the platform separator", async () => {
    const repositoryPackage = resolve(import.meta.dir, "../../package.json");
    const rootLoader = createPromptTemplateLoader(sep);

    const template = await rootLoader.load(repositoryPackage.slice(sep.length));

    expect(template.length).toBeGreaterThan(0);
  });

  test("rejects loading the configured root itself", async () => {
    const rootLoader = createPromptTemplateLoader(sep);

    await expect(rootLoader.load(".")).rejects.toThrow("outside the configured prompt root");
  });
});
