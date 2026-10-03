import { resolve } from "node:path";
import { compileV15WorkflowDefinition } from "../compiler/compile-v15";
import { createPromptTemplateLoader } from "../runtime/prompt-template";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const definitionsRoot = resolve(repositoryRoot, "workflow-config/definitions");
const loader = createPromptTemplateLoader(repositoryRoot);
let failures = 0;
for await (const path of new Bun.Glob("*.json").scan({ cwd: definitionsRoot })) {
  try {
    const compiled = await compileV15WorkflowDefinition(await Bun.file(resolve(definitionsRoot, path)).json(), loader);
    if (!compiled.ok) { console.error(`${path}: ${compiled.error.kind}: ${compiled.error.path}: ${compiled.error.detail}`); failures++; continue; }
    const paths = new Set(compiled.value.prompts.entries.map((entry) => entry.path));
    for await (const prompt of new Bun.Glob("**/*.md").scan({ cwd: resolve(repositoryRoot, "workflow-config/prompts/dev-flow/v15") })) {
      if (!paths.has(`workflow-config/prompts/dev-flow/v15/${prompt}`)) { console.error(`${path}: orphan prompt ${prompt}`); failures++; }
    }
    console.log(`${path}: six stages; ${compiled.value.prompts.entries.length} LLM action points with committed prompts`);
  } catch (error) { console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`); failures++; }
}
if (failures > 0) process.exitCode = 1;
