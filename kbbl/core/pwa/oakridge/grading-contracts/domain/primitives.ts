// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export type ObservationJsonValue = string | number | boolean | null | readonly ObservationJsonValue[] | { readonly [key: string]: ObservationJsonValue };

export type ObservationBrand<Value, Name extends string> = Value & { readonly __brand: Name };
