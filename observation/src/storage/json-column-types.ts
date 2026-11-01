import type { ColumnType } from "kysely";

/** A JSON value encoded as text before crossing the pg driver boundary. */
export type JsonText<Value> = string & { readonly __json: Value };
export type JsonColumn<Value> = ColumnType<Value, JsonText<Value>, JsonText<Value>>;
export type NullableJsonColumn<Value> = ColumnType<Value | null, JsonText<Value> | null, JsonText<Value> | null>;
export type GeneratedJsonColumn<Value> = ColumnType<Value, JsonText<Value> | undefined, JsonText<Value>>;
