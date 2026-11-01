import { createHash } from "node:crypto";
import { canonicalJson, canonicalDigest } from "canonical-json";
import type { PinnedDefinitionRead } from "../storage/read-store";
import type { CanonicalDigest, JsonValue } from "./observation-wire";

function encoded(value: JsonValue): string {
  const result = canonicalJson(value);
  if (!result.ok) throw new Error(`${result.error.operation}: ${result.error.entity_id}: ${result.error.detail}`);
  return result.value;
}

/** Retain the stored digest's domain prefix over the shared canonical bytes. */
export function declarationDigest(declaration: JsonValue): string {
  return `artifact-schema/v1:${createHash("sha256").update(encoded(declaration), "utf8").digest("hex")}`;
}
export function bodyDigest(body: JsonValue): CanonicalDigest {
  const result = canonicalDigest(body);
  if (!result.ok) throw new Error(`${result.error.operation}: ${result.error.entity_id}: ${result.error.detail}`);
  return result.value as CanonicalDigest;
}
/** Only the named artifact's parsed type declaration moves this version. */
export function artifactSchemaVersion(definition: PinnedDefinitionRead, stage: string, artifact: string): string | null {
  const declaration = definition.checked_program.workflow.stages[stage]?.artifacts[artifact];
  return declaration ? declarationDigest(declaration.schema as JsonValue) : null;
}
