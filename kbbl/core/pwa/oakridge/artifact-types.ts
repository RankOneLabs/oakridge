import type { OperatorBodyValue } from "./operator-contracts";

/** An artifact body is plain JSON; viewers read it by field name. */
export type BodyRecord = { readonly [key: string]: OperatorBodyValue };
export const isBodyRecord = (value: OperatorBodyValue | null): value is BodyRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isBodyList = (value: OperatorBodyValue | null): value is readonly OperatorBodyValue[] => Array.isArray(value);

/** A record's field, or null when the value is not a record or the field is absent. */
export const selectBodyField = (value: OperatorBodyValue | null, key: string): OperatorBodyValue | null =>
  isBodyRecord(value) ? value[key] ?? null : null;

export const selectBodyText = (value: OperatorBodyValue | null): string | null => typeof value === "string" ? value : null;

const selectBodyItems = (value: OperatorBodyValue | null): readonly OperatorBodyValue[] => isBodyList(value) ? value : [];

export const selectFieldText = (value: OperatorBodyValue | null, key: string): string | null => selectBodyText(selectBodyField(value, key));

export const selectFieldItems = (value: OperatorBodyValue | null, key: string): readonly OperatorBodyValue[] => selectBodyItems(selectBodyField(value, key));

export const selectHttpUrl = (value: string | null): string | null =>
  value !== null && /^https?:\/\//i.test(value) ? value : null;
