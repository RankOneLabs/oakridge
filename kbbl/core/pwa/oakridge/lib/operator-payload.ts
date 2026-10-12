import type { Result } from "../../lib/result";
import type { OperatorTypeExpression } from "../operator-contracts";
import { parseTypeExpression } from "./type-expression";

export interface OperatorFieldInput { readonly raw: string; readonly type: OperatorTypeExpression | undefined }
export interface OperatorPayloadError {
  readonly operation: "parse_operator_payload";
  readonly type: string | null;
  readonly detail: string;
}

/** Decode operator text before the pinned workflow validates the submitted payload. */
export function parseOperatorFieldValue({ raw, type }: OperatorFieldInput): Result<unknown, OperatorPayloadError> {
  const reject = (detail: string): Result<never, OperatorPayloadError> => ({ ok: false,
    error: { operation: "parse_operator_payload", type: typeof type === "string" ? type : null, detail } });
  if (type === undefined) return reject("Payload type is unavailable. Refresh before submitting.");
  const parsed = parseTypeExpression(type);
  const text = raw.trim();
  if (parsed.kind === "record" || parsed.kind === "list" || parsed.leaf === "json") {
    try { return { ok: true, value: JSON.parse(raw) }; }
    catch { return reject("Enter valid JSON."); }
  }
  if (parsed.leaf === "boolean") {
    if (text !== "true" && text !== "false") return reject("Enter true or false.");
    return { ok: true, value: text === "true" };
  }
  if (parsed.leaf === "integer") {
    if (!/^[+-]?\d+$/.test(text)) return reject("Enter a whole number.");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return reject("Enter a whole number within the safe integer range.");
    return { ok: true, value };
  }
  return { ok: true, value: raw };
}
