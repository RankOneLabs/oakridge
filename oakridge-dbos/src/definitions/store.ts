import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "canonical-json";
import type { AuthoredWorkflow, CodeOperation } from "../core-client/core-types";

export type StoreKind = "workflows" | "prompts" | "operations" | "programs";
export type DefinitionStoreFault =
  | "InvalidStoreId" | "MissingStoreObject" | "InvalidUtf8" | "PromptBOM" | "PromptCR"
  | "PromptNewline" | "InvalidJson" | "NonCanonicalJson" | "StoreHashMismatch"
  | "InvalidDefinition" | "InvalidLaunchCatalog" | "MissingPromptReference" | "MissingOperationReference";
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
export function readProgramObject(root: string, id: string): unknown {
  const object = `programs/${id}`;
  return parseJson(utf8(readBytes(root, "programs", id), object), object);
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
