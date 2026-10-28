import { createHash } from "node:crypto";
import { err, ok, type Result } from "../domain/primitives";
import type { CanonicalizationError } from "../domain/errors";
import type { CanonicalDigest } from "../domain/identity";

/** Canonical JSON v1 uses a plain decimal with at most 15 significant digits. */
function expandDecimal(value: string): string {
  const [mantissa, exponentPart] = value.toLowerCase().split("e");
  if (exponentPart === undefined) return value;
  const isNegative = mantissa.startsWith("-");
  const unsigned = isNegative ? mantissa.slice(1) : mantissa;
  const point = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const decimalPosition = (point < 0 ? unsigned.length : point) + Number(exponentPart);
  const expanded = decimalPosition <= 0 ? `0.${"0".repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return isNegative ? `-${expanded}` : expanded;
}

function canonicalNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) return Number.isSafeInteger(value) ? expandDecimal(value.toString()) : null;
  const decimal = expandDecimal(value.toPrecision(15)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return Number(decimal) === value ? decimal : null;
}

interface State { readonly active: Set<object> }
function encode(value: unknown, path: string, state: State): Result<string, CanonicalizationError> {
  if (value === null || typeof value === "boolean" || typeof value === "string") return ok(JSON.stringify(value));
  if (typeof value === "number") {
    const decimal = canonicalNumber(value);
    return decimal === null ? err({ operation: "canonical_json", entity_id: path, detail: "number is non-finite, unsafe, or cannot round-trip with 15 significant decimal digits" }) : ok(decimal);
  }
  if (typeof value !== "object") return err({ operation: "canonical_json", entity_id: path, detail: "value is not JSON" });
  if (state.active.has(value)) return err({ operation: "canonical_json", entity_id: path, detail: "cyclic value is not JSON" });
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return err({ operation: "canonical_json", entity_id: path, detail: "non-plain object is not JSON" });
  state.active.add(value);
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) { state.active.delete(value); return err({ operation: "canonical_json", entity_id: `${path}/${index}`, detail: "sparse array is not JSON" }); }
      const item = encode(value[index], `${path}/${index}`, state);
      if (!item.ok) { state.active.delete(value); return item; }
      parts.push(item.value);
    }
    state.active.delete(value);
    return ok(`[${parts.join(",")}]`);
  }
  for (const key of Object.keys(value).sort()) {
    const item = encode((value as { readonly [key: string]: unknown })[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, state);
    if (!item.ok) { state.active.delete(value); return item; }
    parts.push(`${JSON.stringify(key)}:${item.value}`);
  }
  state.active.delete(value);
  return ok(`{${parts.join(",")}}`);
}

/** The result is a string whose UTF-8 bytes are the identity input. */
export function canonicalJson(value: unknown): Result<string, CanonicalizationError> {
  return encode(value, "", { active: new Set() });
}

/** Every digest this module exports includes its canonicalization version. */
export function canonicalDigest(value: unknown): Result<CanonicalDigest, CanonicalizationError> {
  const canonical = canonicalJson(value);
  if (!canonical.ok) return canonical;
  const hash = createHash("sha256").update(canonical.value, "utf8").digest("hex");
  return ok(`canonical-json/v1:${hash}` as CanonicalDigest);
}
