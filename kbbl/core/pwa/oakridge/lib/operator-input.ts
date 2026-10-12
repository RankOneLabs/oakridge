import type { OperatorTypeExpression } from "../operator-contracts";
import { parseOperatorFieldValue } from "./operator-payload";
import { parseTypeExpression } from "./type-expression";

/** One field of a record type expression, as the launch form edits it. */
export interface InputField {
  readonly key: string;
  readonly type: OperatorTypeExpression;
  readonly is_optional: boolean;
}
export type FieldDrafts = { readonly [key: string]: string };

/** Null when the input is not a record, which the form renders as raw JSON. */
export function selectInputFields(input: OperatorTypeExpression | undefined): readonly InputField[] | null {
  if (input === undefined) return null;
  const parsed = parseTypeExpression(input);
  if (parsed.kind !== "record") return null;
  return parsed.fields.map(([key, type]) => ({ key, type, is_optional: parseTypeExpression(type).is_optional }));
}

export function inputRecord(raw: string): { [key: string]: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Root input must be a JSON object.");
  return parsed as { [key: string]: unknown };
}

/**
 * v2 type expressions carry no string minimum, so a blank draft means "no
 * value" for every field: omitted when the field is optional, an error when
 * the workflow requires it.
 */
export function buildRootInput(raw: string, fields: readonly InputField[] | null, drafts: FieldDrafts): unknown {
  if (!fields) return JSON.parse(raw);
  const record = inputRecord(raw);
  for (const field of fields) {
    const draft = drafts[field.key];
    if (draft === undefined) {
      if (record[field.key] !== undefined || field.is_optional) continue;
      throw new Error(`${field.key} is required.`);
    }
    if (draft.trim() === "") {
      if (!field.is_optional) throw new Error(`${field.key} is required.`);
      delete record[field.key];
      continue;
    }
    const parsed = parseOperatorFieldValue({ raw: draft, type: field.type });
    if (!parsed.ok) throw new Error(`${field.key}: ${parsed.error.detail}`);
    record[field.key] = parsed.value;
  }
  return record;
}
