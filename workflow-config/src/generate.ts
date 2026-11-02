import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import YAML from "yaml";
import { WORKFLOW_SOURCES } from "./workflow-sources";
import { OPERATION_REGISTRY } from "../../oakridge-dbos/src/operations/registry";
import { decodeWorkflowSource } from "../../kbbl/core/pwa/oakridge/workflow-definition-types";
import { bytesIdentity, jsonIdentity, type DefinitionId, type OperationRegistryId, type PromptId } from "./definition-identity";
import { commitDefinition, referencedPromptPaths, type LaunchableCatalog, type PromptReferences } from "./definition-objects";
import { isPromptPath } from "./definition-store";

const root = resolve(import.meta.dir, "../..");
const isCheck = process.argv.includes("--check");
const storeRoot = resolve(root, "workflow-config/definitions");
const promptRoot = resolve(root, "workflow-config/prompts");

interface GeneratedFile { readonly path: string; readonly bytes: Buffer }
interface AuthoredPrompt { readonly path: string; readonly id: PromptId; readonly bytes: Buffer }
function required<Value, Failure>(result: Result<Value, Failure>): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(required(canonicalJson(value)), "utf8");
}
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  }).sort();
}
function readPrompt(path: string): AuthoredPrompt {
  const bytes = readFileSync(path);
  // Validate without replacing invalid bytes or normalizing the copied prompt.
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path}: invalid UTF-8: ${error}`);
  }
  return { path: relative(promptRoot, path).split(sep).join("/"), id: bytesIdentity(bytes), bytes };
}

const prompts = filesUnder(promptRoot).map(readPrompt);
const promptsByPath = new Map(prompts.map((prompt) => [prompt.path, prompt]));
const registryId = required(jsonIdentity<OperationRegistryId>(OPERATION_REGISTRY));
const generated: GeneratedFile[] = [
  // These pretty-printed outputs remain exactly as before this store existed.
  { path: resolve(root, "workflow-config/operation-registry.json"), bytes: Buffer.from(JSON.stringify(OPERATION_REGISTRY, null, 2) + "\n") },
  { path: resolve(storeRoot, "operations", `${registryId}.json`), bytes: canonicalBytes(OPERATION_REGISTRY) },
  ...prompts.map((prompt) => ({ path: resolve(storeRoot, "prompts", `${prompt.id}.md`), bytes: prompt.bytes })),
];
const launchableEntries: [string, DefinitionId][] = [];
for (const [name, path] of Object.entries(WORKFLOW_SOURCES)) {
  const sourcePath = resolve(root, path);
  const document = YAML.parseDocument(readFileSync(sourcePath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${sourcePath}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  // toJS preserves authored schemas/stages insertion order; capture it before
  // the canonical serializer sorts mapping keys in the committed object.
  const authored = document.toJS();
  const source = decodeWorkflowSource(authored);
  if (source === null) throw new Error(`${sourcePath}: invalid authored workflow shape`);
  const references: PromptReferences = Object.fromEntries(referencedPromptPaths(source).map((path) => {
    const prompt = promptsByPath.get(path);
    if (!isPromptPath(path) || prompt === undefined) throw new Error(`${sourcePath}: missing or invalid prompt path ${path}`);
    return [path, prompt.id];
  }));
  const definition = commitDefinition({ source, operation_registry_id: registryId, prompts: references });
  const definitionId = required(jsonIdentity<DefinitionId>(definition));
  launchableEntries.push([name, definitionId]);
  generated.push(
    { path: resolve(root, "workflow-core/fixtures/bundles", `${name}.json`), bytes: Buffer.from(JSON.stringify(authored, null, 2) + "\n") },
    { path: resolve(storeRoot, "workflows", `${definitionId}.json`), bytes: canonicalBytes(definition) },
  );
}
const launchable: LaunchableCatalog = Object.fromEntries(launchableEntries);
generated.push({ path: resolve(storeRoot, "launchable.json"), bytes: canonicalBytes(launchable) });

// Build and validate the complete output plan before writing anything.
const outputs = new Map(generated.map((file) => [file.path, file]));
for (const file of outputs.values()) {
  if (isCheck) {
    let actual: Buffer;
    try {
      actual = readFileSync(file.path);
    } catch (error) {
      throw new Error(`${file.path} cannot be read; run bun workflow-config/src/generate.ts: ${error}`);
    }
    if (!actual.equals(file.bytes)) throw new Error(`${file.path} differs from its authoring source; run bun workflow-config/src/generate.ts`);
  } else {
    mkdirSync(dirname(file.path), { recursive: true });
    await Bun.write(file.path, file.bytes);
  }
}
// Reconcile only generated object directories so the output depends solely on
// current authoring sources, including after a prompt or registry changes ID.
for (const directory of ["workflows", "prompts", "operations"]) {
  for (const path of filesUnder(resolve(storeRoot, directory))) {
    if (outputs.has(path)) continue;
    if (isCheck) throw new Error(`${path} is stale generated output; run bun workflow-config/src/generate.ts`);
    unlinkSync(path);
  }
}
