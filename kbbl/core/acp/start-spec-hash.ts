import { createHash } from "node:crypto";
import type { AcpSessionStartSpec } from "./types";

// Stable canonicalization of a start spec: sort object keys recursively, then sha256 the JSON. Same spec must hash identically
// regardless of property order in the HTTP body.
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function startSpecHash(spec: AcpSessionStartSpec): string {
  return sha256Hex(JSON.stringify(stableValue(spec)));
}
