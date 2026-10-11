import type { OperatorCheckedValue, OperatorSchema } from "../operator-contracts";

export type CheckedTextStep =
  | { readonly kind: "field"; readonly id: number }
  | { readonly kind: "item"; readonly index: number }
  | { readonly kind: "dictionary"; readonly key: string }
  | { readonly kind: "wrapped" };

export interface CheckedTextField {
  readonly path: readonly CheckedTextStep[];
  readonly label: string;
  readonly value: string;
}

/** Walk the generated checked value, using its schema for operator-facing field names. */
export function selectCheckedTextFields(value: OperatorCheckedValue, schemas: readonly OperatorSchema[]): readonly CheckedTextField[] {
  const fields: CheckedTextField[] = [];
  const visit = (current: OperatorCheckedValue, path: readonly CheckedTextStep[], labels: readonly string[]): void => {
    const data = current.data;
    if (data.kind === "string") {
      fields.push({ path, label: labels.join(" / ") || "Text", value: data.value });
      return;
    }
    if (data.kind === "record") {
      const shape = schemas.find((schema) => schema.key === current.schema)?.shape;
      for (const field of data.fields) {
        if (!field.value) continue;
        const name = shape?.kind === "record" ? shape.fields[field.field_id]?.key : undefined;
        visit(field.value, [...path, { kind: "field", id: field.field_id }], [...labels, name ?? `Field ${field.field_id}`]);
      }
      for (const entry of data.dictionary)
        visit(entry.value, [...path, { kind: "dictionary", key: entry.key }], [...labels, entry.key]);
      return;
    }
    if (data.kind === "list") {
      data.items.forEach((item, index) => visit(item, [...path, { kind: "item", index }], [...labels, String(index + 1)]));
      return;
    }
    if ((data.kind === "optional" || data.kind === "variant") && data.value)
      visit(data.value, [...path, { kind: "wrapped" }], labels);
  };
  visit(value, [], []);
  return fields;
}

/** Preserve all checked structure while replacing one text atom. */
export function replaceCheckedText(value: OperatorCheckedValue, path: readonly CheckedTextStep[], text: string): OperatorCheckedValue | null {
  if (path.length === 0) return value.data.kind === "string" ? { ...value, data: { kind: "string", value: text } } : null;
  const [step, ...rest] = path;
  if (!step) return null;
  const data = value.data;
  if (step.kind === "field" && data.kind === "record") {
    const field = data.fields.find((candidate) => candidate.field_id === step.id);
    const next = field?.value ? replaceCheckedText(field.value, rest, text) : null;
    return next ? { ...value, data: { ...data, fields: data.fields.map((candidate) => candidate.field_id === step.id ? { ...candidate, value: next } : candidate) } } : null;
  }
  if (step.kind === "dictionary" && data.kind === "record") {
    const entry = data.dictionary.find((candidate) => candidate.key === step.key);
    const next = entry ? replaceCheckedText(entry.value, rest, text) : null;
    return next ? { ...value, data: { ...data, dictionary: data.dictionary.map((candidate) => candidate.key === step.key ? { ...candidate, value: next } : candidate) } } : null;
  }
  if (step.kind === "item" && data.kind === "list") {
    const item = data.items[step.index];
    const next = item ? replaceCheckedText(item, rest, text) : null;
    return next ? { ...value, data: { ...data, items: data.items.map((candidate, index) => index === step.index ? next : candidate) } } : null;
  }
  if (step.kind === "wrapped" && (data.kind === "optional" || data.kind === "variant") && data.value) {
    const next = replaceCheckedText(data.value, rest, text);
    return next ? { ...value, data: { ...data, value: next } } : null;
  }
  return null;
}
