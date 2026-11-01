import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "canonical-json";
import YAML from "yaml";
import { WORKFLOW_SOURCES, definitionBytes, type DefinitionContent } from "./workflow-sources";
import { OPERATION_REGISTRY } from "../../oakridge-dbos/src/operations/registry";
import type { AuthoredWorkflow } from "../../oakridge-dbos/src/core-client/core-types";
import { selectPromptPaths } from "../../oakridge-dbos/src/runtime/prompt-files";

const root = resolve(import.meta.dir, "../..");
const isCheck = process.argv.includes("--check");
const store = resolve(root, "definitions");
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function canonical(value: unknown): string {
  const result = canonicalJson(value);
  if (!result.ok) throw new Error(`NonCanonicalJson: ${result.error.entity_id}: ${result.error.detail}`);
  return result.value;
}
function output(path: string, bytes: Uint8Array | string): void {
  const destination = resolve(root, path);
  if (isCheck) {
    if (!existsSync(destination) || !Buffer.from(readFileSync(destination)).equals(Buffer.from(bytes)))
      throw new Error(`GeneratedOutputMismatch: ${path}`);
  } else {
    mkdirSync(resolve(destination, ".."), { recursive: true });
    writeFileSync(destination, bytes);
  }
}
function promptBytes(path: string): Buffer {
  if (!/^[a-zA-Z0-9/_-]+\.md$/.test(path)) throw new Error(`InvalidPromptPath: ${path}`);
  const file = resolve(root, "workflow-config/prompts", path);
  const bytes = readFileSync(file);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith("\uFEFF")) throw new Error(`PromptBOM: ${path}`);
  if (text.includes("\r")) throw new Error(`PromptCR: ${path}`);
  if (!text.endsWith("\n") || text.endsWith("\n\n")) throw new Error(`PromptNewline: ${path}`);
  return bytes;
}
function storeObject(kind: "operations" | "workflows", value: unknown): string {
  const bytes = canonical(value);
  const id = sha256(bytes);
  output(`definitions/${kind}/${id}.json`, bytes);
  return id;
}
function verifyGeneratedObjects(): void {
  for (const kind of ["operations", "workflows", "prompts"] as const) {
    const directory = resolve(store, kind);
    if (!existsSync(directory)) throw new Error(`MissingStoreDirectory: ${directory}`);
    for (const filename of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.(json|md)$/.test(filename)) throw new Error(`InvalidStoreFilename: ${filename}`);
      const bytes = readFileSync(resolve(directory, filename));
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error(`InvalidUtf8: ${kind}/${filename}`); }
      if (kind === "prompts") {
        if (text.startsWith("\uFEFF")) throw new Error(`PromptBOM: ${filename}`);
        if (text.includes("\r")) throw new Error(`PromptCR: ${filename}`);
        if (!text.endsWith("\n") || text.endsWith("\n\n")) throw new Error(`PromptNewline: ${filename}`);
      } else if (canonical(JSON.parse(text)) !== text) throw new Error(`NonCanonicalJson: ${filename}`);
      if (sha256(bytes) !== filename.slice(0, 64)) throw new Error(`StoreHashMismatch: ${filename}`);
      if (kind === "workflows") {
        const object = JSON.parse(text) as { readonly operations?: string; readonly prompts?: { readonly [path: string]: string } };
        if (!object.operations || !existsSync(resolve(store, "operations", `${object.operations}.json`)))
          throw new Error(`MissingOperationReference: ${filename}: ${object.operations}`);
        for (const [path, id] of Object.entries(object.prompts ?? {}))
          if (!existsSync(resolve(store, "prompts", `${id}.md`)))
            throw new Error(`MissingPromptReference: ${filename}: ${path} -> ${id}`);
      }
    }
  }
}
function verifyPreservation(): void {
  const base = process.env.DEFINITIONS_MERGE_BASE;
  if (!base) throw new Error("MissingDefinitionsMergeBase: set DEFINITIONS_MERGE_BASE to the branch used for the committed-object comparison");
  for (const reference of new Set([base, process.env.DEFINITIONS_PR_BASE].filter((value): value is string => Boolean(value)))) {
    const mergeBase = execFileSync("git", ["merge-base", "HEAD", reference], { cwd: root, encoding: "utf8" }).trim();
    const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", mergeBase, "definitions"], { cwd: root, encoding: "utf8" }).trim();
    for (const path of paths ? paths.split("\n") : []) {
      if (!/^definitions\/(prompts|operations|workflows|programs)\//.test(path)) continue;
      const prior = execFileSync("git", ["show", `${mergeBase}:${path}`], { cwd: root });
      if (!existsSync(resolve(root, path)) || !readFileSync(resolve(root, path)).equals(prior))
        throw new Error(`CommittedStoreObjectChanged: ${path}`);
    }
  }
}

const registryFixture = JSON.stringify(OPERATION_REGISTRY, null, 2) + "\n";
output("workflow-config/operation-registry.json", registryFixture);
const operations = storeObject("operations", OPERATION_REGISTRY);
const launchable: { [name: string]: string } = {};
for (const [name, path] of Object.entries(WORKFLOW_SOURCES)) {
  const source = resolve(root, path);
  const document = YAML.parseDocument(readFileSync(source, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${source}: ${document.errors.map((error) => error.message).join("; ")}`);
  const authored: unknown = document.toJS();
  if (authored === null || typeof authored !== "object" || Array.isArray(authored)) throw new Error(`InvalidWorkflow: ${path}`);
  const reference = (authored as { operations?: unknown }).operations;
  if (reference !== undefined && reference !== operations)
    throw new Error(`OperationReferenceMismatch: ${path}: ${String(reference)} != ${operations}`);
  const workflow = { ...authored, operations } as AuthoredWorkflow;
  output(`workflow-core/fixtures/bundles/${name}.json`, JSON.stringify(workflow, null, 2) + "\n");
  const paths = selectPromptPaths(workflow);
  const prompts: { [path: string]: string } = {};
  for (const promptPath of paths) {
    const bytes = promptBytes(promptPath);
    const id = sha256(bytes);
    output(`definitions/prompts/${id}.md`, bytes);
    prompts[promptPath] = id;
  }
  const definition: DefinitionContent = { source: workflow, operations, prompts };
  const encoded = definitionBytes(definition);
  if (!encoded.ok) throw new Error(`NonCanonicalJson: ${encoded.error.entity_id}: ${encoded.error.detail}`);
  const id = sha256(encoded.value);
  output(`definitions/workflows/${id}.json`, encoded.value);
  launchable[name] = id;
}
output("definitions/launchable.json", canonical(launchable));
if (isCheck) { verifyGeneratedObjects(); verifyPreservation(); }
