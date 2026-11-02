import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalizationError, type Result } from "canonical-json";

export type DefinitionId = string & { readonly __brand: "DefinitionId" };
export type PromptId = string & { readonly __brand: "PromptId" };
export type OperationRegistryId = string & { readonly __brand: "OperationRegistryId" };
export type DefinitionIdentity = DefinitionId | PromptId | OperationRegistryId;

export function isIdentity(value: unknown): value is DefinitionIdentity {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** JSON identities use the shared canonical bytes, without a domain prefix. */
export function jsonIdentity<Id extends DefinitionId | OperationRegistryId>(value: unknown): Result<Id, CanonicalizationError> {
  const canonical = canonicalJson(value);
  if (!canonical.ok) return canonical;
  return { ok: true, value: createHash("sha256").update(canonical.value, "utf8").digest("hex") as Id };
}

/** Prompt identity includes every byte, including its original line endings. */
export function bytesIdentity(bytes: Uint8Array): PromptId {
  return createHash("sha256").update(bytes).digest("hex") as PromptId;
}
