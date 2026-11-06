import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import { decodeWorkflowSource, hasSafeWireNumbers, type TypeExpression } from "../../oakridge-dbos/src/core-client/source-types";
import { bytesIdentity, isIdentity, type DefinitionId } from "./definition-identity";
import { referencedPromptPaths, type CommittedDefinition, type LaunchableCatalog, type OperationRegistry, type ResolvedDefinition } from "./definition-objects";

export const DEFINITION_STORE_ROOT = resolve(import.meta.dir, "../definitions");
/** Removed workflow contract fields: no retained definition may carry one, at any depth. */
export const DISCARDED_DEFINITION_FIELDS: readonly string[] = ["gated_review"];
type StoreOperation = "read_definition" | "read_prompt" | "read_operation_registry" | "read_launchable";
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
type ReadContext = Pick<FailureContext, "operation" | "identifier">;
interface ObjectRead extends ReadContext { readonly path: string }
/** Unknown JSON exists only while validating objects at the IO boundary. */
interface JsonObject { readonly [key: string]: unknown }

function failure(kind: DefinitionStoreFailure["kind"], context: ReadContext, detail: string): Result<never, DefinitionStoreFailure> {
  return { ok: false, error: { kind, operation: context.operation, identifier: context.identifier, detail } };
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function isPromptPath(path: string): boolean {
  return !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
/** The discarded fields a parsed definition carries, as JSON pointers. */
export function selectDiscardedFields(value: unknown, pointer = ""): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => selectDiscardedFields(item, `${pointer}/${index}`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, field]) => [
    ...(DISCARDED_DEFINITION_FIELDS.includes(key) ? [`${pointer}/${key}`] : []),
    ...selectDiscardedFields(field, `${pointer}/${key}`),
  ]);
}
function matchesNames(value: unknown, names: readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.length === names.length && new Set(value).size === names.length
    && value.every((name) => typeof name === "string" && names.includes(name));
}
function isCommittedDefinition(value: unknown): value is CommittedDefinition {
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
function readText(request: ObjectRead): Result<string, DefinitionStoreFailure> {
  const bytes = readBytes(request);
  if (!bytes.ok) return bytes;
  const text = decodeUtf8(bytes.value, request);
  if (!text.ok) return text;
  if (request.operation !== "read_launchable" && bytesIdentity(bytes.value) !== request.identifier)
    return failure("hash_mismatch", request, "SHA-256 of stored bytes differs from filename identity");
  return text;
}
function readJson(request: ObjectRead): Result<unknown, DefinitionStoreFailure> {
  const text = readText(request);
  if (!text.ok) return text;
  let value: unknown;
  try {
    value = JSON.parse(text.value);
  } catch (error) {
    return failure("malformed_object", request, String(error));
  }
  if (!hasSafeWireNumbers(value)) return failure("malformed_object", request, "JSON exceeds the wire depth or safe numeric bounds");
  const canonical = canonicalJson(value);
  if (!canonical.ok) return failure("malformed_object", request, canonical.error.detail);
  if (canonical.value !== text.value) return failure("malformed_object", request, "stored JSON is not byte-exact canonical JSON");
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
  if (!isObject(catalog.value) || !Object.values(catalog.value).every(isIdentity)) return failure("malformed_object", context, "expected an authoring-name-to-definition-ID map");
  return { ok: true, value: catalog.value as LaunchableCatalog };
}

export function resolveLaunchableDefinition(name: string, store_root = DEFINITION_STORE_ROOT): Result<ResolvedDefinition, DefinitionStoreFailure> {
  const catalog = readLaunchableCatalog(store_root);
  if (!catalog.ok) return catalog;
  if (!Object.hasOwn(catalog.value, name)) return failure("malformed_object", { operation: "read_launchable", identifier: name }, "authoring name is absent from launchable.json");
  return resolveDefinition(catalog.value[name], store_root);
}
