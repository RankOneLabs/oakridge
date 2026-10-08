import type { Schema, SchemaField } from "../workflow-definition-types";
import { parseOperatorFieldValue } from "./operator-payload";

export interface InputField { readonly field: SchemaField; readonly schema: Schema | undefined }
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
export function stringFloor(schema: Schema | undefined): number | null {
  return schema?.shape.kind === "string" ? schema.shape.min_length : null;
}

export function buildRootInput(raw: string, fields: readonly InputField[] | null, drafts: FieldDrafts): unknown {
  if (!fields) return JSON.parse(raw);
  const record = inputRecord(raw);
  for (const { field, schema } of fields) {
    const floor = stringFloor(schema);
    const draft = drafts[field.key];
    if (draft === undefined) {
      if (record[field.key] !== undefined || !field.required) continue;
      if (floor === 0) { record[field.key] = ""; continue; } // A required zero-minimum string starts as the empty value it admits.
      throw new Error(`${field.key} is required.`);
    }
    if (floor !== null) {
      // Whitespace is content in a string, so only a truly empty draft is a question:
      // omitted when the field is optional, "" when the schema's minimum admits it.
      if (draft === "") {
        if (!field.required) { delete record[field.key]; continue; }
        if (floor > 0) throw new Error(`${field.key} is required.`);
        record[field.key] = "";
        continue;
      }
      if (draft.length < floor) throw new Error(`${field.key} must be at least ${floor} characters.`);
      record[field.key] = draft;
      continue;
    }
    if (draft.trim() === "") {
      if (field.required) throw new Error(`${field.key} is required.`);
      delete record[field.key];
      continue;
    }
    const parsed = parseOperatorFieldValue({ raw: draft, schema });
    if (!parsed.ok) throw new Error(`${field.key}: ${parsed.error.detail}`);
    record[field.key] = parsed.value;
  }
  return record;
}
