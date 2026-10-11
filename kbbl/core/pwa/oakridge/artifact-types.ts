import type { OperatorCheckedValue, OperatorSchema } from "./operator-contracts";

/** Resolve a checked record field through the pinned schema's field order. */
export function selectCheckedField(value: OperatorCheckedValue | null, schemas: readonly OperatorSchema[], key: string): OperatorCheckedValue | null {
  if (value?.data.kind !== "record") return null;
  const shape = schemas.find((schema) => schema.key === value.schema)?.shape;
  if (shape?.kind !== "record") return null;
  const fieldId = shape.fields.findIndex((field) => field.key === key);
  return value.data.fields.find((field) => field.field_id === fieldId)?.value ?? null;
}

export function selectCheckedText(value: OperatorCheckedValue | null): string | null {
  if (value?.data.kind === "string") return value.data.value;
  if (value?.data.kind === "enum") return value.data.variant;
  if (value?.data.kind === "optional") return selectCheckedText(value.data.value ?? null);
  return null;
}

export const selectCheckedItems = (value: OperatorCheckedValue | null): readonly OperatorCheckedValue[] =>
  value?.data.kind === "list" ? value.data.items : [];

export const selectFieldText = (value: OperatorCheckedValue, schemas: readonly OperatorSchema[], key: string): string | null =>
  selectCheckedText(selectCheckedField(value, schemas, key));

export const selectFieldItems = (value: OperatorCheckedValue, schemas: readonly OperatorSchema[], key: string): readonly OperatorCheckedValue[] =>
  selectCheckedItems(selectCheckedField(value, schemas, key));

export const selectHttpUrl = (value: string | null): string | null =>
  value !== null && /^https?:\/\//i.test(value) ? value : null;
