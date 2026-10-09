import type { CheckedValue, DefinitionBundle } from "./generated-contracts";
import type { JsonValue } from "../domain/primitives";
import type { Result } from "../storage/commit";

/** Reverse the checked wire representation using the same field indexes as the compiler. */
export function plainValue(value: CheckedValue, bundle: DefinitionBundle): Result<JsonValue> {
  const data = value.data;
  const failure = (): Result<never> => ({ ok: false, error: { operation: "plain_value", entity_id: value.schema, detail: "checked value does not match its stored schema" } });
  switch (data.kind) {
    case "boolean": case "integer": case "string": return { ok: true, value: data.value };
    case "enum": return { ok: true, value: data.variant };
    case "reference": return { ok: true, value: { brand: data.brand, id: data.id } };
    case "optional": return data.value ? plainValue(data.value, bundle) : { ok: true, value: null };
    case "variant": {
      const result = plainValue(data.value, bundle);
      return result.ok ? { ok: true, value: { kind: data.variant, value: result.value } } : result;
    }
    case "list": {
      const items: JsonValue[] = [];
      for (const item of data.items) { const result = plainValue(item, bundle); if (!result.ok) return result; items.push(result.value); }
      return { ok: true, value: items };
    }
    case "record": {
      const shape = bundle.schemas.find((schema) => schema.key === value.schema)?.shape;
      if (shape?.kind !== "record") return failure();
      const record: { [key: string]: JsonValue } = {};
      for (const field of data.fields) {
        const definition = shape.fields[field.field_id];
        if (!definition) return failure();
        if (!field.value) continue;
        const result = plainValue(field.value, bundle);
        if (!result.ok) return result;
        record[definition.key] = result.value;
      }
      for (const entry of data.dictionary) { const result = plainValue(entry.value, bundle); if (!result.ok) return result; record[entry.key] = result.value; }
      return { ok: true, value: record };
    }
  }
}
