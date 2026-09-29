import { expect, test } from "bun:test";

import { createPromptBundle, type PromptTemplateLoader } from "../src/runtime/prompt-template";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import { compileWorkflowManifest } from "../src/compiler/compile-workflow";

test("prompt bundle hash covers template content without changing the definition version", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const contents = new Map<string, string>();
  const loader: PromptTemplateLoader = { load: async (path) => contents.get(path) ?? path };
  const first = await createPromptBundle(loaded.value, loader);
  contents.set("dev-flow/build_v2.md", "edited build prompt");
  const second = await createPromptBundle(loaded.value, loader);
  expect(second.hash).not.toBe(first.hash);
  expect(loaded.value.version).toBe(15);
  const manifest = compileWorkflowManifest(loaded.value, second, { adapter_version: "adapter-7", artifact_schema_version: "artifacts-3" });
  expect(manifest).toEqual({ ok: true, value: expect.objectContaining({ manifest_version: 1, bundle_pin: {
    definition_version: 15, prompt_bundle_hash: second.hash, adapter_version: "adapter-7", artifact_schema_version: "artifacts-3",
  } }) });
});

test("manifest compilation validates placeholders inside prompt bundle content", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const bundle = await createPromptBundle(loaded.value, { load: async (path) => path === "dev-flow/build_v2.md" ? "Build {{TYPO_SLOT}}" : "valid" });
  const manifest = compileWorkflowManifest(loaded.value, bundle, { adapter_version: "adapter-7", artifact_schema_version: "artifacts-3" });
  expect(manifest.ok).toBe(false);
  if (manifest.ok) return;
  expect(manifest.error.diagnostics).toContainEqual(expect.objectContaining({
    kind: "unbound_placeholder", stage_key: "build", session_role: "build", placeholder: "TYPO_SLOT",
  }));
});

test("bundle cells with the same role and reason remain distinct across stages", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const spec = loaded.value.graph.stages.spec_analyzer!;
  const plan = loaded.value.graph.stages.plan_writer!;
  const definition = { ...loaded.value, graph: { stages: {
    first: { ...spec, operator_role: "spec" as const, config: { ...(spec.config as any),
      prompt_matrix: [{ session_role: "spec", launch_reason: "initial", template_path: "first.md" }],
      role_configs: [{ ...(spec.config as any).role_configs[0], session_role: "spec" }] } },
    second: { ...plan, operator_role: "spec" as const, config: { ...(plan.config as any),
      prompt_matrix: [{ session_role: "spec", launch_reason: "initial", template_path: "second.md" }],
      role_configs: [{ ...(plan.config as any).role_configs[0], session_role: "spec" }] } },
  }, edges: [] } };
  const bundle = await createPromptBundle(definition, { load: async (path) => `content:${path}` });
  expect(bundle.matrix).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage_key: "first", template_path: "first.md", content: "content:first.md" }),
    expect.objectContaining({ stage_key: "second", template_path: "second.md", content: "content:second.md" }),
  ]));
});

test("manifest compilation rejects a declared prompt cell missing from the bundle", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const bundle = await createPromptBundle(loaded.value, { load: async () => "valid" });
  const missing = { ...bundle, matrix: bundle.matrix.filter((entry) => !(entry.stage_key === "build" && entry.launch_reason === "revision_after_assessment")) };
  const manifest = compileWorkflowManifest(loaded.value, missing, { adapter_version: "adapter-7", artifact_schema_version: "artifacts-3" });
  expect(manifest.ok).toBe(false);
  if (manifest.ok) return;
  expect(manifest.error.diagnostics).toContainEqual(expect.objectContaining({
    kind: "prompt_bundle_cell_count", stage_key: "build", session_role: "build", launch_reason: "revision_after_assessment", matches: 0,
  }));
});

test("manifest compilation rejects duplicate bundle matches for a declared cell", async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const bundle = await createPromptBundle(loaded.value, { load: async () => "valid" });
  const cell = bundle.matrix.find((entry) => entry.stage_key === "build" && entry.launch_reason === "initial_build")!;
  const manifest = compileWorkflowManifest(loaded.value, { ...bundle, matrix: [...bundle.matrix, cell] },
    { adapter_version: "adapter-7", artifact_schema_version: "artifacts-3" });
  expect(manifest.ok).toBe(false);
  if (manifest.ok) return;
  expect(manifest.error.diagnostics).toContainEqual(expect.objectContaining({
    kind: "prompt_bundle_cell_count", stage_key: "build", session_role: "build", launch_reason: "initial_build", matches: 2,
  }));
});
