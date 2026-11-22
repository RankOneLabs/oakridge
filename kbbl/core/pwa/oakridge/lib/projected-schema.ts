import type { OperatorSchema, OperatorSchemaShape } from "../operator-contracts/projections/schema-view";

export type ProjectedSchemas = ReadonlyMap<string, OperatorSchemaShape>;

export function indexProjectedSchemas(schemas: readonly OperatorSchema[]): ProjectedSchemas {
  return new Map(schemas.map(({ key, shape }) => [key, shape]));
}

export function matchesProjectedSchema(schemas: ProjectedSchemas, key: string, value: unknown): boolean {
  const shape = schemas.get(key);
  if (!shape) return false;
  switch (shape.kind) {
    case "optional": return value == null || matchesProjectedSchema(schemas, shape.item, value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && value >= shape.min && value <= shape.max;
    case "enum": return typeof value === "string" && shape.variants.includes(value);
    case "uuid": return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
    case "string": {
      if (typeof value !== "string") return false;
      if (key === "ident" && /[\p{Cc}/\\]/u.test(value)) return false;
      const length = Array.from(value).length;
      return length >= shape.min_length && length <= shape.max_length;
    }
    case "list": return Array.isArray(value) && value.length <= shape.max_items
      && value.every((item) => matchesProjectedSchema(schemas, shape.item, item));
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const fields = value as Readonly<Record<string, unknown>>;
      return Object.keys(fields).every((name) => shape.fields.some((field) => field.key === name))
        && shape.fields.every((field) => matchesProjectedSchema(schemas, field.schema, Object.hasOwn(fields, field.key) ? fields[field.key] : undefined));
    }
  }
}
