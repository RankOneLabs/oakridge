import { expect, test } from "bun:test";

import { createPromptBundle, type PromptTemplateLoader } from "../src/runtime/prompt-template";
import { loadDevFlowV14 } from "../src/seed/dev-flow-v14";
import { compileWorkflowManifest } from "../src/compiler/compile-workflow";

test("prompt bundle hash covers template content without changing the definition version", async () => {
  const loaded = await loadDevFlowV14();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const contents = new Map<string, string>();
  const loader: PromptTemplateLoader = { load: async (path) => contents.get(path) ?? path };
  const first = await createPromptBundle(loaded.value, loader);
  contents.set("dev-flow/build_v2.md", "edited build prompt");
  const second = await createPromptBundle(loaded.value, loader);
  expect(second.hash).not.toBe(first.hash);
  expect(loaded.value.version).toBe(14);
  const manifest = compileWorkflowManifest(loaded.value, second, { adapter_version: "adapter-7", artifact_schema_version: "artifacts-3" });
  expect(manifest).toEqual({ ok: true, value: expect.objectContaining({ manifest_version: 1, bundle_pin: {
    definition_version: 14, prompt_bundle_hash: second.hash, adapter_version: "adapter-7", artifact_schema_version: "artifacts-3",
  } }) });
});

test("manifest compilation validates placeholders inside prompt bundle content", async () => {
  const loaded = await loadDevFlowV14();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const bundle = await createPromptBundle(loaded.value, { load: async (path) => path === "dev-flow/build_v2.md" ? "Build {{TYPO_SLOT}}" : "valid" });
  const manifest = compileWorkflowManifest(loaded.value, bundle, { adapter_version: "adapter-7", artifact_schema_version: "artifacts-3" });
  expect(manifest.ok).toBe(false);
  if (manifest.ok) return;
  expect(manifest.error.diagnostics).toContainEqual(expect.objectContaining({
    kind: "unbound_placeholder", stage_key: "build", session_role: "build", placeholder: "TYPO_SLOT",
  }));
});
