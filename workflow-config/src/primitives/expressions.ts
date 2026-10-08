import type { Expression, FieldExpression, ReferenceRoot } from "../source-contracts";

/** Small constructors for the existing Rust expression contract. */
export const reference = (root: ReferenceRoot, path: string[] = []): Expression => ({ kind: "reference", root, path });
export const literal = (schema: string, value: unknown): Expression => ({ kind: "literal", schema, value });
export const record = (schema: string, fields: FieldExpression[]): Expression => ({ kind: "record", schema, fields });
export const optional = (schema: string, value: Expression | null): Expression => ({ kind: "optional", schema, value });
type VariantInput = Omit<Extract<Expression, { kind: "variant" }>, "kind">;
export const variant = (input: VariantInput): Expression => ({ kind: "variant", ...input });
/** True when a list has an item: `every` over an empty list is vacuously true. */
export const nonEmpty = (source: Expression): Expression =>
  ({ kind: "not", value: { kind: "every", source, predicate: literal("flag", false) } });
