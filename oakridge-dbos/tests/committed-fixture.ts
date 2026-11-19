import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { canonicalJson } from "canonical-json";
import type { CompileInput } from "../src/core-client/client";
import { OPERATION_REGISTRY } from "../src/operations/registry";
import { DEFINITION_STORE_ROOT, composePrompts, readLaunchableCatalog, referencedPromptPaths, type ComposedPromptMap, type DefinitionId } from "../src/runtime/definition-store";

let test_root: string | null = null;
const previous = process.env.OAKRIDGE_DEFINITION_ROOT;
function storeRoot(): string {
  if (test_root !== null) return test_root;
  test_root = mkdtempSync("/tmp/oakridge-committed-fixture-");
  cpSync(DEFINITION_STORE_ROOT, test_root, { recursive: true });
  process.env.OAKRIDGE_DEFINITION_ROOT = test_root;
  return test_root;
}
process.on("exit", () => {
  if (previous === undefined) delete process.env.OAKRIDGE_DEFINITION_ROOT;
  else process.env.OAKRIDGE_DEFINITION_ROOT = previous;
  if (test_root !== null) rmSync(test_root, { recursive: true, force: true });
});
function jsonBytes(value: unknown): string {
  const result = canonicalJson(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}
export async function sampleDefinition(name: "review-loop" | "fan-out" | "development" = "review-loop"): Promise<CommittedFixture> {
  const catalog = readLaunchableCatalog(storeRoot());
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  return { definition_id: catalog.value[name].definition_id };
}
interface PromptEdit { readonly path: string; readonly content: string }
/** Generate test-only committed objects with the production object format and canonical bytes. */
interface CommittedFixture { readonly definition_id: DefinitionId }
interface CommittedFixtureRequest {
  readonly audience?: import("../src/runtime/definition-store").WorkflowAudience;
  readonly source: CompileInput["workflow"];
  readonly prompt_edit?: PromptEdit;
  readonly operations?: readonly import("../src/core-client/core-types").CodeOperation[];
}
export async function commitTestDefinition(request: CommittedFixtureRequest): Promise<CommittedFixture> {
  const { source, prompt_edit: edit, operations = OPERATION_REGISTRY } = request;
  const root = storeRoot();
  const put = (directory: string, bytes: string, extension: string): string => {
    const id = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(resolve(root, directory), { recursive: true });
    writeFileSync(resolve(root, directory, `${id}.${extension}`), bytes);
    return id;
  };
  const authored_root = resolve(import.meta.dir, "../../workflow-config/prompts");
  const authored = readdirSync(authored_root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => relative(authored_root, resolve(entry.parentPath, entry.name)).split(sep).join("/"));
  const sources = Object.fromEntries(authored.map((path) => [path, readFileSync(resolve(authored_root, path), "utf8")]));
  const composed = composePrompts(referencedPromptPaths(source), edit ? { ...sources, [edit.path]: edit.content } : sources);
  if (!composed.ok) throw new Error(composed.error.detail);
  const commit = (prompts: ComposedPromptMap) => Object.fromEntries(Object.entries(prompts).map(([path, prompt]) => [path, put("prompts", prompt.text, "md")]));
  const prompts = commit(composed.value.prompts);
  const prompt_sources = commit(composed.value.prompt_sources);
  const operation_registry_id = put("operations", jsonBytes(operations), "json");
  const definition_id = put("workflows", jsonBytes({ source, prompts, prompt_sources, operation_registry_id,
    schema_names: Object.keys(source.schemas ?? {}), stage_names: Object.keys(source.stages) }), "json") as DefinitionId;
  const catalog = JSON.parse(readFileSync(resolve(root, "launchable.json"), "utf8"));
  writeFileSync(resolve(root, "launchable.json"), jsonBytes({ ...catalog, [definition_id]: { definition_id, audience: request.audience ?? "user" } }));
  return { definition_id };
}
