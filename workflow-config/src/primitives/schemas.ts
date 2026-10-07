import type { Schema, SchemaField } from "../source-contracts";

export const field = (key: string, schema: string): SchemaField => ({ key, schema, required: true });
export const optionalField = (key: string, schema: string): SchemaField => ({ key, schema, required: false });
export const recordSchema = (key: string, fields: SchemaField[]): Schema => ({
  key, shape: { kind: "record", fields, dictionary: null },
});
