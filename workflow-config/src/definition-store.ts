import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import { decodeWorkflowSource, hasSafeWireNumbers, type TypeExpression } from "../../oakridge-dbos/src/core-client/source-types";
import { jsonIdentity, bytesIdentity, isIdentity, type DefinitionId } from "./definition-identity";
import { referencedPromptPaths, type CommittedDefinition, type LaunchableCatalog, type OperationRegistry, type ResolvedDefinition } from "./definition-objects";

export const DEFINITION_STORE_ROOT = resolve(import.meta.dir, "../definitions");
type StoreOperation = "read_definition" | "read_prompt" | "read_operation_registry" | "read_launchable" | "read_skill_index" | "read_skill_bundle" | "read_prompt_version" | "read_prompt_pointer";
interface FailureContext {
  readonly operation: StoreOperation;
  readonly identifier: string;
  readonly detail: string;
}
export interface HashMismatch extends FailureContext { readonly kind: "hash_mismatch" }
export interface MalformedObject extends FailureContext { readonly kind: "malformed_object" }
export interface InvalidUtf8 extends FailureContext { readonly kind: "invalid_utf8" }
export interface MissingPrompt extends FailureContext { readonly kind: "missing_prompt" }
export interface MissingOperationRegistry extends FailureContext { readonly kind: "missing_operation_registry" }
export interface StoreIoFailure extends FailureContext { readonly kind: "store_io" }
export type DefinitionStoreFailure = HashMismatch | MalformedObject | InvalidUtf8 | MissingPrompt | MissingOperationRegistry | StoreIoFailure;
export type ReadContext = Pick<FailureContext, "operation" | "identifier">;
interface ObjectRead extends ReadContext { readonly path: string }
/** Unknown JSON exists only while validating objects at the IO boundary. */
interface JsonObject { readonly [key: string]: unknown }

export function failure(kind: DefinitionStoreFailure["kind"], context: ReadContext, detail: string): Result<never, DefinitionStoreFailure> {
  return { ok: false, error: { kind, operation: context.operation, identifier: context.identifier, detail } };
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function isPromptPath(path: string): boolean {
  return !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function matchesNames(value: unknown, names: readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.length === names.length && new Set(value).size === names.length
    && value.every((name) => typeof name === "string" && names.includes(name));
}
export function isCommittedDefinition(value: unknown): value is CommittedDefinition {
  if (!isObject(value) || !hasOnlyKeys(value, ["source", "operation_registry_id", "prompts", "schema_names", "stage_names"])) return false;
  const source = decodeWorkflowSource(value.source);
  if (source === null || !isIdentity(value.operation_registry_id) || !isObject(value.prompts)) return false;
  if (!Object.entries(value.prompts).every(([path, id]) => isPromptPath(path) && isIdentity(id))) return false;
  const paths = referencedPromptPaths(source);
  return matchesNames(Object.keys(value.prompts), paths)
    && matchesNames(value.schema_names, Object.keys(source.schemas ?? {}))
    && matchesNames(value.stage_names, Object.keys(source.stages));
}
/** Mirrors workflow-model::Type (the input_schema/output_schema contract). */
function isTypeExpression(value: unknown, depth = 0): value is TypeExpression {
  return depth <= 256 && (typeof value === "string" || (isObject(value) && Object.values(value).every((field) => isTypeExpression(field, depth + 1))));
}
function isOperationRegistry(value: unknown): value is OperationRegistry {
  return Array.isArray(value) && value.every((operation) => isObject(operation)
    && hasOnlyKeys(operation, ["key", "input_schema", "output_schema", "error_codes"])
    && typeof operation.key === "string"
    && isTypeExpression(operation.input_schema) && isTypeExpression(operation.output_schema)
    && (operation.error_codes === undefined || (Array.isArray(operation.error_codes) && operation.error_codes.every((code) => typeof code === "string"))));
}

function readBytes(request: ObjectRead): Result<Uint8Array, DefinitionStoreFailure> {
  try {
    return { ok: true, value: readFileSync(request.path) };
  } catch (error) {
    const is_missing = isObject(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
    const kind = is_missing && request.operation === "read_prompt" ? "missing_prompt"
      : is_missing && request.operation === "read_operation_registry" ? "missing_operation_registry" : "store_io";
    return failure(kind, request, String(error));
  }
}
function decodeUtf8(bytes: Uint8Array, context: ReadContext): Result<string, DefinitionStoreFailure> {
  try {
    // Preserve a BOM as text, too: decoding must not silently discard any bytes.
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch (error) {
    return failure("invalid_utf8", context, String(error));
  }
}
export function readText(request: ObjectRead): Result<string, DefinitionStoreFailure> {
  const bytes = readBytes(request);
  if (!bytes.ok) return bytes;
  const text = decodeUtf8(bytes.value, request);
  if (!text.ok) return text;
  if (request.operation !== "read_launchable" && request.operation !== "read_prompt_pointer" && bytesIdentity(bytes.value) !== request.identifier)
    return failure("hash_mismatch", request, request.path + ": SHA-256 of stored bytes differs from filename identity");
  return text;
}
export function readJson(request: ObjectRead): Result<unknown, DefinitionStoreFailure> {
  const text = readText(request);
  if (!text.ok) return text;
  let value: unknown;
  try {
    value = JSON.parse(text.value);
  } catch (error) {
    return failure("malformed_object", request, request.path + ": " + String(error));
  }
  if (!hasSafeWireNumbers(value)) return failure("malformed_object", request, "JSON exceeds the wire depth or safe numeric bounds");
  const canonical = canonicalJson(value);
  if (!canonical.ok) return failure("malformed_object", request, canonical.error.detail);
  if (canonical.value !== text.value) return failure("malformed_object", request, request.path + ": stored JSON is not byte-exact canonical JSON");
  return { ok: true, value };
}

/** Resolve only verified committed bytes; no authored files or live registry are read. */
export function resolveDefinition(definition_id: DefinitionId, store_root = DEFINITION_STORE_ROOT): Result<ResolvedDefinition, DefinitionStoreFailure> {
  const context: ReadContext = { operation: "read_definition", identifier: definition_id };
  if (!isIdentity(definition_id)) return failure("malformed_object", context, "expected a lowercase 64-hex definition identity");
  const definition = readJson({ ...context, path: resolve(store_root, "workflows", `${definition_id}.json`) });
  if (!definition.ok) return definition;
  if (!isCommittedDefinition(definition.value)) return failure("malformed_object", context, "invalid committed definition shape, ordered names, or prompt references");
  const committed = definition.value;
  const registry_context: ReadContext = { operation: "read_operation_registry", identifier: committed.operation_registry_id };
  const operations = readJson({ ...registry_context, path: resolve(store_root, "operations", `${committed.operation_registry_id}.json`) });
  if (!operations.ok) return operations;
  if (!isOperationRegistry(operations.value)) return failure("malformed_object", registry_context, "invalid operation registry shape");
  const prompt_entries: [string, string][] = [];
  for (const [path, prompt_id] of Object.entries(committed.prompts)) {
    const prompt = readText({ operation: "read_prompt", identifier: prompt_id, path: resolve(store_root, "prompts", `${prompt_id}.md`) });
    if (!prompt.ok) return prompt;
    prompt_entries.push([path, prompt.value]);
  }
  return { ok: true, value: {
    definition_id,
    source: committed.source,
    operation_registry_id: committed.operation_registry_id,
    prompts: Object.fromEntries(prompt_entries),
    operations: operations.value,
    schema_names: committed.schema_names,
    stage_names: committed.stage_names,
  } };
}

export function readLaunchableCatalog(store_root = DEFINITION_STORE_ROOT): Result<LaunchableCatalog, DefinitionStoreFailure> {
  const context: ReadContext = { operation: "read_launchable", identifier: "launchable.json" };
  const catalog = readJson({ ...context, path: resolve(store_root, "launchable.json") });
  if (!catalog.ok) return catalog;
  if (!isObject(catalog.value) || !Object.values(catalog.value).every((entry) => isObject(entry) && Object.keys(entry).length === 2 && hasOnlyKeys(entry, ["audience", "definition_id"]) && isIdentity(entry.definition_id) && (entry.audience === "user" || entry.audience === "test_fixture"))) return failure("malformed_object", context, "expected an authoring-name-to-definition-ID map");
  return { ok: true, value: catalog.value as LaunchableCatalog };
}

export function resolveLaunchableDefinition(name: string, store_root = DEFINITION_STORE_ROOT): Result<ResolvedDefinition, DefinitionStoreFailure> {
  const catalog = readLaunchableCatalog(store_root);
  if (!catalog.ok) return catalog;
  if (!Object.hasOwn(catalog.value, name)) return failure("malformed_object", { operation: "read_launchable", identifier: name }, "authoring name is absent from launchable.json");
  return resolveDefinition(catalog.value[name].definition_id, store_root);
}

/** Current PR skill pins, derived from authored bundle directories. */
export interface SkillIndex { readonly "gated-review": string; readonly "github-cli": string }
export interface SkillBundle { readonly files: { readonly [path: string]: Uint8Array } }
export function readSkillIndex(store_root = process.env.OAKRIDGE_DEFINITION_ROOT ?? DEFINITION_STORE_ROOT): Result<SkillIndex, DefinitionStoreFailure> {
  const context: ReadContext = { operation: "read_skill_index", identifier: "skills.json" };
  try {
    const text = readFileSync(resolve(store_root, "skills.json"), "utf8");
    const value: unknown = JSON.parse(text);
    if (!isObject(value) || !hasOnlyKeys(value, ["gated-review", "github-cli"]) || !isIdentity(value["gated-review"]) || !isIdentity(value["github-cli"]))
      return failure("malformed_object", context, "expected gated-review and github-cli skill digests");
    const canonical = canonicalJson(value);
    if (!canonical.ok || canonical.value !== text) return failure("malformed_object", context, "skill index is not canonical JSON");
    return { ok: true, value: { "gated-review": value["gated-review"], "github-cli": value["github-cli"] } };
  } catch (cause) { return failure("store_io", context, String(cause)); }
}
export function readSkillBundle(digest: string, store_root = process.env.OAKRIDGE_DEFINITION_ROOT ?? DEFINITION_STORE_ROOT): Result<SkillBundle, DefinitionStoreFailure> {
  const context: ReadContext = { operation: "read_skill_bundle", identifier: digest };
  if (!isIdentity(digest)) return failure("malformed_object", context, "expected lowercase 64-hex skill digest");
  try {
    const root = realpathSync(store_root);
    const directory = resolve(root, "skills", digest);
    const entries: [string, Uint8Array][] = [];
    const collect = (directory_path: string, prefix: string): void => {
      for (const entry of readdirSync(directory_path, { withFileTypes: true })) {
        const path = resolve(directory_path, entry.name);
        if (realpathSync(path) !== path || entry.isSymbolicLink()) throw new Error("skill bundles may not contain symlinks");
        const name = prefix + entry.name;
        if (entry.isDirectory()) collect(path, name + "/");
        else if (entry.isFile()) entries.push([name, readFileSync(path)]);
        else throw new Error("skill bundles contain only regular files");
      }
    };
    if (realpathSync(directory) !== directory || realpathSync(resolve(root, "skills")) !== resolve(root, "skills"))
      return failure("store_io", context, "skill directory may not be a symlink");
    collect(directory, "");
    const identity = jsonIdentity<DefinitionId>({ files: Object.fromEntries(entries.map(([path, bytes]) => [path, bytesIdentity(bytes)])) });
    if (!identity.ok) return failure("malformed_object", context, identity.error.detail);
    if (identity.value !== digest) return failure("hash_mismatch", context, "skill manifest SHA-256 differs from bundle identity");
    return { ok: true, value: { files: Object.fromEntries(entries) } };
  } catch (cause) { return failure("store_io", context, String(cause)); }
}

export function launchableDefinitionIds(catalog: LaunchableCatalog, audience: import("./definition-objects").WorkflowAudience | null): DefinitionId[] {
  return [...new Set(Object.values(catalog).filter((entry) => audience === null || entry.audience === audience).map((entry) => entry.definition_id))];
}
