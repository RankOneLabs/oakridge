import { type Result } from "canonical-json";
import { resolve } from "node:path";
import { DEFINITION_STORE_ROOT, failure, isObject, isPromptPath, readJson, type ReadContext, type DefinitionStoreFailure } from "./definition-store";
import { isIdentity, type PromptId, type PromptVersionId } from "./definition-identity";
export type { PromptVersionId } from "./definition-identity";

export interface PromptVersionObject { readonly prompt_id: PromptId; readonly source_path: string }
export interface PromptHistoryEntry { readonly published_at: string | null; readonly version_id: PromptVersionId }
export interface PromptPointer { readonly history: readonly PromptHistoryEntry[]; readonly pending: PromptVersionId | null; readonly published: PromptVersionId; readonly source_path: string }

export function readPromptVersion(version_id: PromptVersionId, store_root = DEFINITION_STORE_ROOT): Result<PromptVersionObject, DefinitionStoreFailure> {
  const path = `prompt-versions/${version_id}.json`;
  const context: ReadContext = { operation: "read_prompt_version", identifier: version_id };
  if (!isIdentity(version_id)) return failure("malformed_object", context, path + ": invalid version identity");
  const result = readJson({ ...context, path: resolve(store_root, path) });
  if (!result.ok) return result;
  const value = result.value;
  if (!isObject(value) || Object.keys(value).length !== 2 || !isIdentity(value.prompt_id) || typeof value.source_path !== "string" || !isPromptPath(value.source_path))
    return failure("malformed_object", context, path + ": invalid version object");
  return { ok: true, value: value as unknown as PromptVersionObject };
}
export function readPromptPointer(source_path: string, store_root = DEFINITION_STORE_ROOT): Result<PromptPointer, DefinitionStoreFailure> {
  const path = `prompt-pointers/${source_path}.json`;
  const context: ReadContext = { operation: "read_prompt_pointer", identifier: path };
  if (!isPromptPath(source_path)) return failure("malformed_object", context, path + ": invalid prompt path");
  const result = readJson({ ...context, path: resolve(store_root, path) });
  if (!result.ok) return result;
  const value = result.value;
  if (!isObject(value) || Object.keys(value).length !== 4 || value.source_path !== source_path || !isIdentity(value.published)
    || !(value.pending === null || isIdentity(value.pending)) || !Array.isArray(value.history) || value.history.length === 0
    || !value.history.every((entry: unknown) => isObject(entry) && Object.keys(entry).length === 2 && isIdentity(entry.version_id)
      && (entry.published_at === null || typeof entry.published_at === "string"))
    || value.history[value.history.length - 1].version_id !== value.published)
    return failure("malformed_object", context, path + ": invalid prompt pointer");
  const pointer = value as unknown as PromptPointer;
  for (const id of [...pointer.history.map(entry => entry.version_id), ...(pointer.pending === null ? [] : [pointer.pending])]) {
    const version = readPromptVersion(id, store_root);
    if (!version.ok) return version;
    if (version.value.source_path !== source_path) return failure("malformed_object", context, path + ": version source path mismatch");
  }
  return { ok: true, value: pointer };
}
