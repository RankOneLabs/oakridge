import type { Result } from "../../lib/result";
import type { OperatorDefinitionBundle } from "../operator-contracts/projections/definition-view";
import type { OperatorSchemaShape } from "../operator-contracts/projections/schema-view";
import { indexProjectedSchemas, matchesProjectedSchema, type ProjectedSchemas } from "./projected-schema";

export type LaunchInputDraft = Readonly<Record<string, string>>;
export interface LaunchInputRefusal { readonly detail: string }
export interface LaunchField {
  readonly key: string;
  readonly schema: string;
  readonly shape: OperatorSchemaShape;
  readonly optional: boolean;
}
export interface LaunchInputSchema {
  readonly root: string;
  readonly schemas: ProjectedSchemas;
  readonly fields: readonly LaunchField[];
}

export function selectLaunchInputSchema(bundle: OperatorDefinitionBundle): LaunchInputSchema | null {
  const root = bundle.units.find((unit) => unit.key === bundle.root)?.input_schema;
  const schemas = indexProjectedSchemas(bundle.schemas);
  if (!root) return null;
  const record = schemas.get(root);
  if (record?.kind !== "record") return null;
  return { root, schemas, fields: record.fields.flatMap(({ key, schema }) => {
    const declared = schemas.get(schema);
    const shape = declared?.kind === "optional" ? schemas.get(declared.item) : declared;
    return shape ? [{ key, schema, shape, optional: declared?.kind === "optional" }] : [];
  }) };
}

export function selectWorkflowLaunchInput(schema: LaunchInputSchema, draft: LaunchInputDraft):
  Result<Readonly<Record<string, unknown>>, LaunchInputRefusal> {
  const values: [string, unknown][] = [];
  for (const field of schema.fields) {
    const raw = draft[field.key] ?? "";
    if (field.optional && raw.trim() === "") continue;
    let value: unknown = raw;
    switch (field.shape.kind) {
      case "record": case "list":
        try { value = JSON.parse(raw); }
        catch { return { ok: false, error: { detail: `${field.key} must contain valid JSON.` } }; }
        break;
      case "integer": value = /^-?\d+$/.test(raw) ? Number(raw) : null; break;
      case "boolean": value = raw === "true" ? true : raw === "false" ? false : null; break;
    }
    if (!matchesProjectedSchema(schema.schemas, field.schema, value))
      return { ok: false, error: { detail: `${field.key} does not match ${field.schema}.` } };
    values.push([field.key, value]);
  }
  const input = Object.fromEntries(values);
  return matchesProjectedSchema(schema.schemas, schema.root, input)
    ? { ok: true, value: input }
    : { ok: false, error: { detail: "Input does not match the workflow's launch schema." } };
}
