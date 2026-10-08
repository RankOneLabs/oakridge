import { createHash } from "node:crypto";

/** Hash the source JSON shape incrementally, before a compiler digest exists. */
export function bundleContentHash(value: unknown): string {
  const hash = createHash("sha256");
  const ancestors = new Set<object>();
  function atom(tag: string, content = ""): void {
    hash.update(tag).update(String(Buffer.byteLength(content))).update(":").update(content);
  }
  function visit(item: unknown): void {
    if (item === null) { atom("n"); return; }
    if (typeof item === "string") { atom("s", item); return; }
    if (typeof item === "boolean") { atom("b", item ? "1" : "0"); return; }
    if (typeof item === "number" && Number.isFinite(item)) { atom("d", String(item)); return; }
    if (typeof item !== "object") throw new Error("bundle contains a non-JSON value");
    if (ancestors.has(item)) throw new Error("bundle contains a cycle");
    ancestors.add(item);
    if (Array.isArray(item)) {
      atom("a", String(item.length));
      item.forEach(visit);
    } else {
      const keys = Object.keys(item);
      atom("o", String(keys.length));
      for (const key of keys) { atom("k", key); visit((item as { readonly [key: string]: unknown })[key]); }
    }
    ancestors.delete(item);
  }
  visit(value);
  return hash.digest("hex");
}
