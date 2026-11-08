// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export type OperatorJsonValue = OperatorJsonPrimitive | readonly OperatorJsonValue[] | { readonly [key: string]: OperatorJsonValue };

export type OperatorJsonPrimitive = string | number | boolean | null;
