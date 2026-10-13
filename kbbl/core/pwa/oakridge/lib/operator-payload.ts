import type { Result } from "../../lib/result";
import type { OperatorSchema } from "../operator-contracts";

export interface OperatorFieldInput { readonly raw: string; readonly schema: OperatorSchema | undefined }
export interface OperatorPayloadError {
  readonly operation: "parse_operator_payload";
  readonly schema_key: string | null;
  readonly detail: string;
}

/** Decode operator text before the pinned schema validates the submitted payload. */
export function parseOperatorFieldValue({ raw, schema }: OperatorFieldInput): Result<unknown, OperatorPayloadError> {
  const reject = (detail: string): Result<never, OperatorPayloadError> => ({ ok: false,
    error: { operation: "parse_operator_payload", schema_key: schema?.key ?? null, detail } });
  if (!schema) return reject("Payload schema is unavailable. Refresh before submitting.");
  const text = raw.trim();
  if (schema.shape.kind === "boolean") {
    if (text !== "true" && text !== "false") return reject("Enter true or false.");
    return { ok: true, value: text === "true" };
  }
  if (schema.shape.kind === "integer") {
    if (!/^[+-]?\d+$/.test(text)) return reject("Enter a whole number.");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return reject("Enter a whole number within the safe integer range.");
    if (value < schema.shape.min || value > schema.shape.max)
      return reject(`Enter a whole number from ${schema.shape.min} to ${schema.shape.max}.`);
    return { ok: true, value };
  }
  if (schema.shape.kind === "record" || schema.shape.kind === "list" || schema.shape.kind === "optional") {
    try { return { ok: true, value: JSON.parse(raw) as unknown }; }
    catch { return reject("Enter valid JSON."); }
  }
  return { ok: true, value: raw };
}
