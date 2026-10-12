/**
 * v2 artifact bodies are plain JSON, so a text atom is addressed by object key
 * and array index rather than by a pinned schema's field order.
 */
export type BodyTextStep =
  | { readonly kind: "field"; readonly key: string }
  | { readonly kind: "item"; readonly index: number };

export interface BodyTextField {
  readonly path: readonly BodyTextStep[];
  readonly label: string;
  readonly value: string;
}

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Every editable string in a body, labelled by its path for the operator. */
export function selectBodyTextFields(value: unknown): readonly BodyTextField[] {
  const fields: BodyTextField[] = [];
  const visit = (current: unknown, path: readonly BodyTextStep[], labels: readonly string[]): void => {
    if (typeof current === "string") {
      fields.push({ path, label: labels.join(" / ") || "Text", value: current });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, { kind: "item", index }], [...labels, String(index + 1)]));
      return;
    }
    if (isRecord(current))
      for (const [key, nested] of Object.entries(current))
        visit(nested, [...path, { kind: "field", key }], [...labels, key]);
  };
  visit(value, [], []);
  return fields;
}

/** Preserve all surrounding structure while replacing one text atom. */
export function replaceBodyText(value: unknown, path: readonly BodyTextStep[], text: string): unknown | null {
  if (path.length === 0) return typeof value === "string" ? text : null;
  const [step, ...rest] = path;
  if (!step) return null;
  if (step.kind === "field" && isRecord(value)) {
    if (!(step.key in value)) return null;
    const next = replaceBodyText(value[step.key], rest, text);
    return next === null ? null : { ...value, [step.key]: next };
  }
  if (step.kind === "item" && Array.isArray(value)) {
    const item = value[step.index];
    if (item === undefined) return null;
    const next = replaceBodyText(item, rest, text);
    return next === null ? null : value.map((candidate, index) => index === step.index ? next : candidate);
  }
  return null;
}
