import { createHash } from "node:crypto";
import type { PinnedDefinitionRead } from "../storage/read-store";
import type { CanonicalDigest, JsonValue } from "./observation-wire";

function expandDecimal(value: string): string {
  const [mantissa, exponentPart] = value.toLowerCase().split("e");
  if (exponentPart === undefined) return value;
  const isNegative = mantissa.startsWith("-");
  const unsigned = isNegative ? mantissa.slice(1) : mantissa;
  const point = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const position = (point < 0 ? unsigned.length : point) + Number(exponentPart);
  const expanded = position <= 0 ? `0.${"0".repeat(-position)}${digits}`
    : position >= digits.length ? `${digits}${"0".repeat(position - digits.length)}`
      : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return isNegative ? `-${expanded}` : expanded;
}
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new Error("unsafe JSON integer");
    return expandDecimal(value.toString());
  }
  const decimal = expandDecimal(value.toPrecision(15)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (Number(decimal) !== value) throw new Error("JSON number cannot round-trip with 15 significant digits");
  return decimal;
}
/** Canonical JSON v1's sorted-key encoding, matching the service's digest. */
export function canonicalJson(value: JsonValue): string {
  if (typeof value === "number") return canonicalNumber(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const fields = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key]!)}`).join(",")}}`;
}
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export function bodyDigest(body: JsonValue): CanonicalDigest { return `canonical-json/v1:${sha256(canonicalJson(body))}` as CanonicalDigest; }
export function declarationDigest(declaration: JsonValue): string { return `artifact-schema/v1:${sha256(canonicalJson(declaration))}`; }
/** Only the named artifact's parsed type declaration moves this version. */
export function artifactSchemaVersion(definition: PinnedDefinitionRead, stage: string, artifact: string): string | null {
  const declaration = definition.checked_program.workflow.stages[stage]?.artifacts[artifact];
  return declaration ? declarationDigest(declaration.schema as JsonValue) : null;
}
