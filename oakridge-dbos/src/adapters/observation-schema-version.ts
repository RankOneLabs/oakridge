import { createHash } from "node:crypto";
import { canonicalJson, canonicalDigest } from "canonical-json";
import type { ParsedWorkflow, Type } from "../core-client/core-types";
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
/** Reachable named types participate in identity; unrelated schemas and prompts do not. */
export function resolvedSchemaDigest(workflow: ParsedWorkflow, schema: Type): string | null {
  const named = new Map<string, Type>();
  const pending: Type[] = [schema];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    switch (current.kind) {
      case "named": {
        if (named.has(current.schema)) break;
        const definition = Object.hasOwn(workflow.schemas ?? {}, current.schema) ? workflow.schemas?.[current.schema] : undefined;
        if (!definition) return null;
        named.set(current.schema, definition);
        pending.push(definition);
        break;
      }
      case "record": pending.push(...Object.values(current.fields)); break;
      case "list": pending.push(current.item); break;
      case "optional": pending.push(current.value); break;
    }
  }
  return declarationDigest({ schema: schema as JsonValue, schemas: Object.fromEntries(named) as JsonValue });
}
/** The canonical contract introduced spec_body. Older pinned definitions retain
 * their exact v1 declaration hashes; no artifact body participates in dispatch. */
export function parsedArtifactSchemaVersion(workflow: ParsedWorkflow, stage: string, artifact: string): string | null {
  const declaration = workflow.stages[stage]?.artifacts[artifact];
  if (!declaration) return null;
  const isCanonicalContract = workflow.workflow === "development" && Object.hasOwn(workflow.schemas ?? {}, "spec_body");
  return isCanonicalContract ? resolvedSchemaDigest(workflow, declaration.schema) : declarationDigest(declaration.schema as JsonValue);
}
export function artifactSchemaVersion(definition: PinnedDefinitionRead, stage: string, artifact: string): string | null {
  return parsedArtifactSchemaVersion(definition.checked_program.workflow, stage, artifact);
}

/** Hash at the read boundary; projections consume these deterministic values. */
export const artifactSchemaVersions = (workflow: ParsedWorkflow): import("../storage/read-store").ArtifactSchemaVersions =>
  Object.fromEntries(Object.entries(workflow.stages).map(([stage, value]) => [stage,
    Object.fromEntries(Object.keys(value.artifacts).map((artifact) => [artifact, parsedArtifactSchemaVersion(workflow, stage, artifact)])),
  ]));
