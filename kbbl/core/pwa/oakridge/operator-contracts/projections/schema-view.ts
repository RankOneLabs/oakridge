// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorSchema { readonly key: string; readonly shape: OperatorSchemaShape }

export type OperatorSchemaShape =
  | { readonly kind: "uuid"; readonly generated: true }
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "string"; readonly min_length: number; readonly max_length: number }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly OperatorSchemaField[] }
  | { readonly kind: "list"; readonly item: string; readonly max_items: number }
  | { readonly kind: "optional"; readonly item: string };

export interface OperatorSchemaField { readonly key: string; readonly schema: string }
