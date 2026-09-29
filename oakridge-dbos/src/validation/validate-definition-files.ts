import { resolve } from "node:path";

import { compileWorkflowManifest } from "../compiler/compile-workflow";
import { createPromptBundle, createPromptTemplateLoader } from "../runtime/prompt-template";
import { parseWorkflowDefinition } from "./workflow-definition";
import { createDevFlowAdapterRegistry } from "../adapters/dev-flow";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const definitionsRoot = resolve(repositoryRoot, "workflow-config/definitions");
const promptLoader = createPromptTemplateLoader(resolve(repositoryRoot, "workflow-config/prompts"));
const failures: string[] = [];
const adapterRoles = createDevFlowAdapterRegistry();

for await (const relativePath of new Bun.Glob("*.json").scan({ cwd: definitionsRoot })) {
  const source = await Bun.file(resolve(definitionsRoot, relativePath)).json();
  const parsed = parseWorkflowDefinition(source, adapterRoles);
  if (!parsed.ok) {
    failures.push(`${relativePath}: ${parsed.error.detail}`);
    continue;
  }
  try {
    const bundle = await createPromptBundle(parsed.value, promptLoader);
    const compiled = compileWorkflowManifest(parsed.value, bundle, { adapter_version: "delegated-session-v1", artifact_schema_version: "v1" });
    if (!compiled.ok) failures.push(`${relativePath}: ${compiled.error.detail}`);
  } catch (error) {
    failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("all workflow definitions compiled to version 1 manifests");
}
