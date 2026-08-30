import type { JsonValue } from "./primitives";

/** RFC 6901 escaping: `~1` is `/`, `~0` is `~`, and order matters. */
const decodeJsonPointerSegment = (segment: string): string => segment.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * Read a JSON Pointer, or `undefined` where it does not resolve.
 *
 * There were three of these with divergent semantics — unit materialization,
 * execution resolution, and the stage compiler each carried their own — and the
 * loose ones accepted a pointer with no leading `/` by silently dropping its
 * first segment, so a mistyped path read a different field instead of failing.
 * This is the strict reading: absent leading slash and non-numeric array index
 * both resolve to nothing.
 */
export const readJsonPointer = (value: JsonValue, pointer: string): JsonValue | undefined => {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current: JsonValue | undefined = value;
  for (const token of pointer.slice(1).split("/").map(decodeJsonPointerSegment)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object") {
      current = (current as Readonly<Record<string, JsonValue>>)[token];
    } else {
      return undefined;
    }
  }
  return current;
};
