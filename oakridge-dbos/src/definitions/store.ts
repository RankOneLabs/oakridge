import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "canonical-json";
import { CORE_PROTOCOL_SCHEMA, type AuthoredWorkflow, type CodeOperation } from "../core-client/core-types";
import type { CompiledAgainst } from "../core-client/client";

export type StoreKind = "workflows" | "prompts" | "operations" | "programs";
export type DefinitionStoreFault =
  | "InvalidStoreId" | "MissingStoreObject" | "InvalidUtf8" | "PromptBOM" | "PromptCR"
  | "PromptNewline" | "InvalidJson" | "NonCanonicalJson" | "StoreHashMismatch"
  | "InvalidDefinition" | "InvalidProgram" | "InvalidLaunchCatalog" | "NotLaunchable"
  | "MissingPromptReference" | "MissingOperationReference";
export class DefinitionStoreError extends Error {
  constructor(readonly kind: DefinitionStoreFault, readonly object: string, detail: string) {
    super(`${kind}: ${object}: ${detail}`);
    this.name = kind;
  }
}
export interface CommittedDefinition {
  readonly source: AuthoredWorkflow;
  readonly operations: string;
  readonly prompts: Readonly<{ [path: string]: string }>;
}
export interface LoadedDefinition {
  readonly id: string;
  readonly definition: CommittedDefinition;
  readonly prompts: Readonly<{ [path: string]: string }>;
  readonly operations: readonly CodeOperation[];
}
export interface HistoricalDefinitionRead {
  readonly definition: LoadedDefinition;
  readonly program: CompiledAgainst;
}
/** The root is configured once for every store read made by the running service. */
export function definitionRoot(): string {
  return process.env.OAKRIDGE_DEFINITION_ROOT ?? resolve(import.meta.dir, "../../../definitions");
}
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const idPattern = /^[a-f0-9]{64}$/;
function pathFor(root: string, kind: StoreKind, id: string): string {
  if (!idPattern.test(id)) throw new DefinitionStoreError("InvalidStoreId", `${kind}/${id}`, "expected lowercase SHA-256");
  return resolve(root, kind, `${id}.${kind === "prompts" ? "md" : "json"}`);
}
function readBytes(root: string, kind: StoreKind, id: string): Uint8Array {
  const path = pathFor(root, kind, id);
  try { return readFileSync(path); }
  catch { throw new DefinitionStoreError("MissingStoreObject", `${kind}/${id}`, `file ${path} is absent`); }
}
function utf8(bytes: Uint8Array, object: string): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new DefinitionStoreError("InvalidUtf8", object, "file is not valid UTF-8"); }
}
function verifyHash(bytes: Uint8Array, kind: StoreKind, id: string): void {
  if (kind !== "programs" && hash(bytes) !== id)
    throw new DefinitionStoreError("StoreHashMismatch", `${kind}/${id}`, "file bytes do not hash to the filename");
}
function parseJson(text: string, object: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new DefinitionStoreError("InvalidJson", object, "file is not JSON"); }
}
export function readJsonObject(root: string, kind: "workflows" | "operations", id: string): unknown {
  const object = `${kind}/${id}`;
  const bytes = readBytes(root, kind, id);
  const text = utf8(bytes, object);
  const value = parseJson(text, object);
  const encoded = canonicalJson(value);
  if (!encoded.ok || encoded.value !== text)
    throw new DefinitionStoreError("NonCanonicalJson", object, encoded.ok ? "bytes are not Canonical JSON v1" : encoded.error.detail);
  verifyHash(bytes, kind, id);
  return value;
}
export function readPromptObject(root: string, id: string): string {
  const object = `prompts/${id}`;
  const bytes = readBytes(root, "prompts", id);
  const text = utf8(bytes, object);
  if (text.startsWith("\uFEFF")) throw new DefinitionStoreError("PromptBOM", object, "prompt starts with a BOM");
  if (text.includes("\r")) throw new DefinitionStoreError("PromptCR", object, "prompt contains CR");
  if (!text.endsWith("\n") || text.endsWith("\n\n"))
    throw new DefinitionStoreError("PromptNewline", object, "prompt must end in exactly one newline");
  verifyHash(bytes, "prompts", id);
  return text;
}
/** Program records are keyed by definition ID, not by their own bytes. */
export function readProgramObject(root: string, id: string): CompiledAgainst {
  const object = `programs/${id}`;
  const bytes = readBytes(root, "programs", id);
  const text = utf8(bytes, object);
  const value = parseJson(text, object);
  const encoded = canonicalJson(value);
  if (!encoded.ok || encoded.value !== text)
    throw new DefinitionStoreError("NonCanonicalJson", object, encoded.ok ? "bytes are not Canonical JSON v1" : encoded.error.detail);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DefinitionStoreError("InvalidProgram", object, "expected a compiled program object");
  const program = value as Partial<CompiledAgainst>;
  if (!Array.isArray(program.operations) || !program.operations.every((operation) => matchesCoreSchema(operation, "CodeOperation")) ||
      !matchesCoreSchema({ digest: program.digest, workflow: program.workflow, stages: program.stages }, "CompiledWorkflow"))
    throw new DefinitionStoreError("InvalidProgram", object, "recorded program has an invalid compiled workflow or operation registry");
  return program as CompiledAgainst;
}
type CoreSchema = boolean | CoreSchemaObject;
interface CoreSchemaObject {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly CoreSchema[];
  readonly anyOf?: readonly CoreSchema[];
  readonly allOf?: readonly CoreSchema[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<{ [key: string]: CoreSchema }>;
  readonly additionalProperties?: boolean | CoreSchema;
  readonly items?: CoreSchema;
  readonly minimum?: number;
  readonly maximum?: number;
}
/** Validate exported programs against the compiler's generated wire model, without invoking the compiler. */
function matchesCoreSchema(value: unknown, name: "CodeOperation" | "CompiledWorkflow"): boolean {
  const definitions: Readonly<{ [name: string]: CoreSchema }> = CORE_PROTOCOL_SCHEMA.response.$defs;
  const matches = (candidate: unknown, schema: CoreSchema, depth: number): boolean => {
    if (depth > 1024) return false;
    if (typeof schema === "boolean") return schema;
    if (schema.$ref) {
      const referenced = definitions[schema.$ref.replace("#/$defs/", "")];
      return referenced !== undefined && matches(candidate, referenced, depth + 1);
    }
    if (Object.hasOwn(schema, "const") && candidate !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(candidate)) return false;
    if (schema.oneOf && schema.oneOf.filter((member) => matches(candidate, member, depth + 1)).length !== 1) return false;
    if (schema.anyOf && !schema.anyOf.some((member) => matches(candidate, member, depth + 1))) return false;
    if (schema.allOf && !schema.allOf.every((member) => matches(candidate, member, depth + 1))) return false;
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (types && !types.some((type) => type === "null" ? candidate === null
      : type === "array" ? Array.isArray(candidate)
      : type === "object" ? typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      : type === "integer" ? typeof candidate === "number" && Number.isSafeInteger(candidate)
      : type === "number" ? typeof candidate === "number" && Number.isFinite(candidate)
      : typeof candidate === type)) return false;
    if (typeof candidate === "number" && ((schema.minimum !== undefined && candidate < schema.minimum)
      || (schema.maximum !== undefined && candidate > schema.maximum))) return false;
    if (Array.isArray(candidate) && schema.items && !candidate.every((member) => matches(member, schema.items!, depth + 1))) return false;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Readonly<{ [key: string]: unknown }>;
      if (schema.required?.some((key) => !Object.hasOwn(record, key))) return false;
      for (const [key, member] of Object.entries(record)) {
        const property = schema.properties?.[key];
        if (property && !matches(member, property, depth + 1)) return false;
        if (!property && schema.additionalProperties === false) return false;
        if (!property && typeof schema.additionalProperties === "object" && !matches(member, schema.additionalProperties, depth + 1)) return false;
      }
    }
    return true;
  };
  const schema = definitions[name];
  return schema !== undefined && matches(value, schema, 0);
}
export function readLaunchCatalog(root: string): Readonly<{ [name: string]: string }> {
  let bytes: Uint8Array;
  try { bytes = readFileSync(resolve(root, "launchable.json")); }
  catch { throw new DefinitionStoreError("MissingStoreObject", "launchable.json", "catalog is absent"); }
  const text = utf8(bytes, "launchable.json");
  const value = parseJson(text, "launchable.json");
  const encoded = canonicalJson(value);
  if (!encoded.ok || encoded.value !== text)
    throw new DefinitionStoreError("NonCanonicalJson", "launchable.json", "catalog bytes are not Canonical JSON v1");
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some((id) => typeof id !== "string" || !idPattern.test(id)))
    throw new DefinitionStoreError("InvalidLaunchCatalog", "launchable.json", "expected a name to definition ID map");
  return value as { [name: string]: string };
}
export function loadDefinition(root: string, id: string): LoadedDefinition {
  const candidate = readJsonObject(root, "workflows", id);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new DefinitionStoreError("InvalidDefinition", `workflows/${id}`, "expected definition object");
  const record = candidate as Partial<CommittedDefinition>;
  if (!record.source || typeof record.operations !== "string" || !record.prompts || typeof record.prompts !== "object" || Array.isArray(record.prompts))
    throw new DefinitionStoreError("InvalidDefinition", `workflows/${id}`, "source, operations and prompts are required");
  if (record.source.operations !== record.operations)
    throw new DefinitionStoreError("InvalidDefinition", `workflows/${id}`, "source operation reference differs");
  const prompts: { [path: string]: string } = {};
  for (const [path, promptId] of Object.entries(record.prompts)) {
    if (typeof promptId !== "string") throw new DefinitionStoreError("InvalidDefinition", `workflows/${id}`, `invalid prompt ID at ${path}`);
    try { prompts[path] = readPromptObject(root, promptId); }
    catch (error) {
      if (error instanceof DefinitionStoreError && error.kind === "MissingStoreObject")
        throw new DefinitionStoreError("MissingPromptReference", `workflows/${id}`, `${path} -> ${promptId}`);
      throw error;
    }
  }
  let operations: unknown;
  try { operations = readJsonObject(root, "operations", record.operations); }
  catch (error) {
    if (error instanceof DefinitionStoreError && error.kind === "MissingStoreObject")
      throw new DefinitionStoreError("MissingOperationReference", `workflows/${id}`, record.operations);
    throw error;
  }
  if (!Array.isArray(operations)) throw new DefinitionStoreError("InvalidDefinition", `workflows/${id}`, "operations must be an array");
  return { id, definition: record as CommittedDefinition, prompts, operations: operations as CodeOperation[] };
}

/** Resolve the exact committed source, prompt bytes and operation registry used to compile. */
export function resolveExecutionDefinition(id: string, root = definitionRoot()): LoadedDefinition {
  return loadDefinition(root, id);
}

/** Starting a run requires an entry in the launch catalog, not merely an object on disk. */
export function resolveLaunchDefinition(id: string, root = definitionRoot()): LoadedDefinition {
  if (!Object.values(readLaunchCatalog(root)).includes(id))
    throw new DefinitionStoreError("NotLaunchable", `workflows/${id}`, "definition is absent from launchable.json");
  return resolveExecutionDefinition(id, root);
}

/** Historical reads use the exported executable program and never invoke today's compiler. */
export function resolveHistoricalDefinition(id: string, root = definitionRoot()): HistoricalDefinitionRead {
  return { definition: loadDefinition(root, id), program: readProgramObject(root, id) };
}
