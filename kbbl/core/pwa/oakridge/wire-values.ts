export const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
export const object = (value: unknown, field: string): { readonly [key: string]: unknown } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`parse run event: invalid ${field}`);
  return value as { readonly [key: string]: unknown };
};
export const string = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`parse run event: invalid ${field}`);
  return value;
};
export const number = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`parse run event: invalid ${field}`);
  return value;
};
