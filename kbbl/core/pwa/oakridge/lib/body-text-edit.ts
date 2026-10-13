import type { OperatorBodyValue } from "../operator-contracts";
import { isBodyList, isBodyRecord } from "../artifact-types";

/** Where a text value sits in a body: a record field by key, or a list item by position. */
export type BodyTextStep = { readonly kind: "field"; readonly key: string } | { readonly kind: "item"; readonly index: number };

export interface BodyTextField {
  readonly path: readonly BodyTextStep[];
  readonly label: string;
  readonly value: string;
}

/** Every text value in a body, labelled by its field names and list positions. */
export function selectBodyTextFields(value: OperatorBodyValue): readonly BodyTextField[] {
  const fields: BodyTextField[] = [];
  const visit = (current: OperatorBodyValue, path: readonly BodyTextStep[], labels: readonly string[]): void => {
    if (typeof current === "string") { fields.push({ path, label: labels.join(" / ") || "Text", value: current }); return; }
    if (isBodyRecord(current))
      for (const [key, field] of Object.entries(current)) visit(field, [...path, { kind: "field", key }], [...labels, key]);
    else if (isBodyList(current))
      current.forEach((item, index) => visit(item, [...path, { kind: "item", index }], [...labels, String(index + 1)]));
  };
  visit(value, [], []);
  return fields;
}

/** The body with one text value replaced, every other value kept; null when the path names no text. */
export function replaceBodyText(value: OperatorBodyValue, path: readonly BodyTextStep[], text: string): OperatorBodyValue | null {
  const [step, ...rest] = path;
  if (!step) return typeof value === "string" ? text : null;
  if (step.kind === "field" && isBodyRecord(value) && step.key in value) {
    const next = replaceBodyText(value[step.key] ?? null, rest, text);
    return next === null ? null : { ...value, [step.key]: next };
  }
  if (step.kind === "item" && isBodyList(value) && step.index < value.length) {
    const next = replaceBodyText(value[step.index] ?? null, rest, text);
    return next === null ? null : value.map((item, index) => index === step.index ? next : item);
  }
  return null;
}
