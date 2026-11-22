import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalizationError } from "canonical-json";
import type { ParsedWorkflow, Type } from "../core-client/core-types";
import { err, ok, type Result } from "../domain/primitives";
import type { PinnedDefinitionRead } from "../storage/read-store";
import type { JsonValue } from "./revision-delivery";

/** Retain the stored digest's domain prefix over the shared canonical bytes. */
function schemaDigest(declaration: JsonValue): Result<string, CanonicalizationError> {
  const encoded = canonicalJson(declaration);
  if (!encoded.ok) return encoded;
  return ok(`artifact-schema/v2:${createHash("sha256").update(encoded.value, "utf8").digest("hex")}`);
}
interface SchemaResolution {
  readonly type: Type;
  readonly schemas: NonNullable<ParsedWorkflow["schemas"]>;
  readonly visiting: ReadonlySet<string>;
}
interface SchemaResolutionFailure {
  readonly operation: "resolve_artifact_schema"; readonly entity_id: string; readonly detail: string;
}
/** Expand only the artifact's transitive schema dependencies, independent of alias names. */
function resolveSchema(input: SchemaResolution): Result<Type, SchemaResolutionFailure> {
  const { type, schemas, visiting } = input;
  switch (type.kind) {
    case "named": {
      const referenced = schemas[type.schema];
      if (!referenced || visiting.has(type.schema)) return err({ operation: "resolve_artifact_schema",
        entity_id: type.schema, detail: referenced ? "recursive schema reference" : "missing schema reference" });
      return resolveSchema({ type: referenced, schemas, visiting: new Set([...visiting, type.schema]) });
    }
    case "record": {
      const fields: { [key: string]: Type } = {};
      for (const [name, field] of Object.entries(type.fields)) {
        const resolved = resolveSchema({ ...input, type: field });
        if (!resolved.ok) return resolved;
        fields[name] = resolved.value;
      }
      return ok({ kind: "record", fields });
    }
    case "list": {
      const item = resolveSchema({ ...input, type: type.item });
      return item.ok ? ok({ kind: "list", item: item.value }) : item;
    }
    case "optional": {
      const value = resolveSchema({ ...input, type: type.value });
      return value.ok ? ok({ kind: "optional", value: value.value }) : value;
    }
    default: return ok(type);
  }
}
export function parsedArtifactSchemaVersion(workflow: ParsedWorkflow, stage: string, artifact: string): string | null {
  const declaration = workflow.stages[stage]?.artifacts[artifact];
  if (!declaration) return null;
  const resolved = resolveSchema({ type: declaration.schema, schemas: workflow.schemas ?? {}, visiting: new Set() });
  if (!resolved.ok) return null;
  const digest = schemaDigest(resolved.value);
  return digest.ok ? digest.value : null;
}

export function runInputSchemaVersion(workflow: Pick<ParsedWorkflow, "input" | "schemas">): Result<string, SchemaResolutionFailure | CanonicalizationError> {
  const resolved = resolveSchema({ type: workflow.input, schemas: workflow.schemas ?? {}, visiting: new Set() });
  return resolved.ok ? schemaDigest(resolved.value) : resolved;
}

export function artifactSchemaVersion(definition: PinnedDefinitionRead, stage: string, artifact: string): string | null {
  return parsedArtifactSchemaVersion(definition.checked_program.workflow, stage, artifact);
}

/** The same pinned versions feed every operator revision projection. */
export const artifactSchemaVersions = (workflow: ParsedWorkflow): import("../storage/read-store").ArtifactSchemaVersions =>
  Object.fromEntries(Object.entries(workflow.stages).map(([stage, value]) => [stage,
    Object.fromEntries(Object.keys(value.artifacts).map((artifact) => [artifact, parsedArtifactSchemaVersion(workflow, stage, artifact)])),
  ]));
