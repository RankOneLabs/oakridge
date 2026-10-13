import type { OperatorSchema, OperatorSchemaField } from "../operator-contracts";
import { parseOperatorFieldValue } from "./operator-payload";

export interface InputField { readonly field: OperatorSchemaField; readonly schema: OperatorSchema | undefined }
export type FieldDrafts = { readonly [key: string]: string };

export function inputRecord(raw: string): { [key: string]: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Root input must be a JSON object.");
  return parsed as { [key: string]: unknown };
}

/**
 * A string schema's own `min_length` decides whether "" is an acceptable value,
 * so the form stops imposing a non-empty rule the bundle never stated. Null for
 * every other shape, where a blank entry really does mean "no value".
 */
export function stringFloor(schema: OperatorSchema | undefined): number | null {
  return schema?.shape.kind === "string" ? schema.shape.min_length : null;
}

/** An `optional(T)` field admits null; every other field needs a value. */
export const isOptionalSchema = (schema: OperatorSchema | undefined): boolean => schema?.shape.kind === "optional";

/**
 * The record the form submits. The core requires every field to be present:
 * an untouched optional field is null, an untouched zero-minimum string is "".
 */
export function buildRootInput(raw: string, fields: readonly InputField[] | null, drafts: FieldDrafts): unknown {
  if (!fields) return JSON.parse(raw);
  const record = inputRecord(raw);
  for (const { field, schema } of fields) {
    const floor = stringFloor(schema);
    const draft = drafts[field.key];
    if (draft === undefined) {
      if (record[field.key] !== undefined) continue;
      if (isOptionalSchema(schema)) { record[field.key] = null; continue; }
      if (floor === 0) { record[field.key] = ""; continue; }
      throw new Error(`${field.key} is required.`);
    }
    if (floor !== null) {
      // Whitespace is content in a string, so only the schema's minimum decides a short entry.
      if (draft === "" && floor > 0) throw new Error(`${field.key} is required.`);
      if (draft.length < floor) throw new Error(`${field.key} must be at least ${floor} characters.`);
      record[field.key] = draft;
      continue;
    }
    if (draft.trim() === "") {
      if (!isOptionalSchema(schema)) throw new Error(`${field.key} is required.`);
      record[field.key] = null;
      continue;
    }
    const parsed = parseOperatorFieldValue({ raw: draft, schema });
    if (!parsed.ok) throw new Error(`${field.key}: ${parsed.error.detail}`);
    record[field.key] = parsed.value;
  }
  return record;
}
