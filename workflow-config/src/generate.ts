import { readPromptPointer, readPromptVersion } from "./prompt-versions";
import { readText } from "./definition-store";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import YAML from "yaml";
import { expandIncludes } from "./workflow-include";
import { discoverWorkflowSources } from "./workflow-sources";
import { OPERATION_REGISTRY } from "../../oakridge-dbos/src/operations/registry";
import { decodeWorkflowSource } from "../../oakridge-dbos/src/core-client/source-types";
import { bytesIdentity, jsonIdentity, type DefinitionId, type OperationRegistryId, type PromptId } from "./definition-identity";
import { commitDefinition, referencedPromptPaths, type DefinitionOrder, type LaunchableCatalog, type LaunchableEntry } from "./definition-objects";
import { isCommittedDefinition, isPromptPath } from "./definition-store";
import { composePrompts, promptReferences } from "../../oakridge-dbos/src/runtime/definition-store";

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

/** Decodability, rather than a list of retired fields, governs retention. */
function selectIncompatibleDefinitions(): string[] {
  const directory = resolve(storeRoot, "workflows");
  if (!existsSync(directory)) return [];
  return filesUnder(directory).filter((path) => {
    // Read failures must abort generation before any retained object is removed.
    const contents = readFileSync(path, "utf8");
    try {
      return !isCommittedDefinition(JSON.parse(contents));
    } catch {
      return true;
    }
  });
}

const prompts = filesUnder(promptRoot).map(readPrompt);
// Validate every pointer before planning or writing outputs, including unreferenced paths.
const pointerRoot = resolve(storeRoot, "prompt-pointers");
const publishedPrompts = new Map<string, AuthoredPrompt>();
if (existsSync(pointerRoot)) for (const file of filesUnder(pointerRoot).filter(path => !path.endsWith(".tmp"))) {
  const path = relative(pointerRoot, file).split(sep).join("/").replace(/\.json$/, "");
  const pointer = required(readPromptPointer(path, storeRoot));
  const version = required(readPromptVersion(pointer.published, storeRoot));
  const body = required(readText({ operation: "read_prompt", identifier: version.prompt_id, path: resolve(storeRoot, "prompts", version.prompt_id + ".md") }));
  const bytes = Buffer.from(body);
  publishedPrompts.set(path, { path, id: version.prompt_id, bytes });
}
for (let index = 0; index < prompts.length; index++) {
  const authored = prompts[index];
  const published = publishedPrompts.get(authored.path);
  if (!published) continue;
  if (authored.id !== published.id) console.error(`prompt ${authored.path}: authored file ${authored.id} differs from published version ${published.id}; using the published version`);
  prompts[index] = published;
}
const promptTexts = Object.fromEntries(prompts.map((prompt) => [prompt.path, prompt.bytes.toString("utf8")]));
const registryId = required(jsonIdentity<OperationRegistryId>(OPERATION_REGISTRY));
const generated: GeneratedFile[] = [
  // These pretty-printed outputs remain exactly as before this store existed.
  { path: resolve(root, "workflow-config/operation-registry.json"), bytes: Buffer.from(JSON.stringify(OPERATION_REGISTRY, null, 2) + "\n") },
  { path: resolve(storeRoot, "operations", `${registryId}.json`), bytes: canonicalBytes(OPERATION_REGISTRY) },
  ...prompts.map((prompt) => ({ path: resolve(storeRoot, "prompts", `${prompt.id}.md`), bytes: prompt.bytes })),
];
const skillRoot = resolve(root, "workflow-config/skills/pr-operations");
const skillEntries = readdirSync(skillRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
  const directory = resolve(skillRoot, entry.name);
  const files = filesUnder(directory).map((path) => ({ path: relative(directory, path).split(sep).join("/"), bytes: readFileSync(path) }));
  const digest = required(jsonIdentity<DefinitionId>({ files: Object.fromEntries(files.map((file) => [file.path, bytesIdentity(file.bytes)])) }));
  generated.push(...files.map((file) => ({ path: resolve(storeRoot, "skills", digest, file.path), bytes: file.bytes })));
  return [entry.name, digest];
});
generated.push({ path: resolve(storeRoot, "skills.json"), bytes: canonicalBytes(Object.fromEntries(skillEntries)) });
const launchableEntries: [string, LaunchableEntry][] = [];
for (const { name, path, audience } of discoverWorkflowSources(root)) {
  const sourcePath = resolve(root, path);
  const sourceDocument = YAML.parseDocument(readFileSync(sourcePath, "utf8"), { uniqueKeys: true });
  if (sourceDocument.errors.length > 0) {
    throw new Error(`${sourcePath}: ${sourceDocument.errors.map((error) => error.message).join("; ")}`);
  }
  const document = required(expandIncludes(sourceDocument, (path) =>
    YAML.parseDocument(readFileSync(resolve(root, "workflow-config", path), "utf8"), { uniqueKeys: true })));
  // YAML nodes preserve authored order, including integer-like names that
  // JavaScript object enumeration would reorder after toJS().
  const schemas = document.get("schemas");
  const stages = document.get("stages");
  if ((schemas != null && !YAML.isMap(schemas)) || !YAML.isMap(stages)) {
    throw new Error(`${sourcePath}: invalid authored schemas or stages mapping`);
  }
  const order: DefinitionOrder = {
    schema_names: schemas?.items.map(({ key }) => String(key)) ?? [],
    stage_names: stages.items.map(({ key }) => String(key)),
    worker_names: Object.fromEntries(stages.items.map(({ key, value }) => {
      const workers = YAML.isMap(value) ? value.get("workers") : undefined;
      return [String(key), YAML.isMap(workers) ? workers.items.map((worker) => String(worker.key)) : []];
    })),
  };
  const authored = document.toJS();
  const source = decodeWorkflowSource(authored);
  if (source === null) throw new Error(`${sourcePath}: invalid authored workflow shape`);
  const paths = referencedPromptPaths(source);
  for (const path of paths) if (!isPromptPath(path)) throw new Error(`${sourcePath}: invalid prompt path ${path}`);
  // Each prompt is committed with its includes expanded, so the definition id covers every byte a session receives.
  const composed = required(composePrompts(paths, promptTexts));
  generated.push(...Object.values(composed.prompts).map((prompt) => ({ path: resolve(storeRoot, "prompts", `${prompt.id}.md`), bytes: Buffer.from(prompt.text) })));
  const definition = commitDefinition({ source, operation_registry_id: registryId,
    prompts: promptReferences(composed.prompts), prompt_sources: promptReferences(composed.prompt_sources) }, order);
  const definitionId = required(jsonIdentity<DefinitionId>(definition));
  launchableEntries.push([name, { audience, definition_id: definitionId }]);
  generated.push(
    { path: resolve(root, "workflow-core/fixtures/bundles", `${name}.json`), bytes: Buffer.from(JSON.stringify(authored, null, 2) + "\n") },
    { path: resolve(storeRoot, "workflows", `${definitionId}.json`), bytes: canonicalBytes(definition) },
  );
}
const launchable: LaunchableCatalog = Object.fromEntries(launchableEntries);
generated.push({ path: resolve(storeRoot, "launchable.json"), bytes: canonicalBytes(launchable) });

// Build and validate the complete output plan before writing anything.
const incompatible = selectIncompatibleDefinitions();
if (isCheck && incompatible.length > 0) {
  throw new Error(incompatible.map((path) => `${path} is not a decodable committed definition; run bun workflow-config/src/generate.ts`).join("\n"));
}
// Remove incompatible retained bytes before creating any new objects.
if (!isCheck) for (const path of incompatible) rmSync(path);
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
    if (!existsSync(file.path) || !readFileSync(file.path).equals(file.bytes)) await Bun.write(file.path, file.bytes);
  }
}
