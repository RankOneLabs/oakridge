import { expect, test } from "bun:test";
import * as canonicalModule from "../src/index";
import type { CanonicalDigest } from "../src/index";
import type { Result } from "../src/index";

const { canonicalDigest, canonicalJson } = canonicalModule;

function value(result: ReturnType<typeof canonicalJson>): string {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}
function digest(result: ReturnType<typeof canonicalDigest>): string {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

test("object key order does not change a digest", () => {
  expect(digest(canonicalDigest({ b: 2, a: 1 }))).toBe(digest(canonicalDigest({ a: 1, b: 2 })));
});
test("nested object order is irrelevant but array order is significant", () => {
  const left = { items: [{ z: 2, a: 1 }, 3] };
  expect(digest(canonicalDigest(left))).toBe(digest(canonicalDigest({ items: [{ a: 1, z: 2 }, 3] })));
  expect(digest(canonicalDigest(left))).not.toBe(digest(canonicalDigest({ items: [3, { a: 1, z: 2 }] })));
});
test("unicode strings and escaped JSON strings have one UTF-8 representation", () => {
  expect(value(canonicalJson({ "é": "snowman ☃\n" }))).toBe('{"é":"snowman ☃\\n"}');
  expect(digest(canonicalDigest(JSON.parse('{"\\u00e9":"snowman \\u2603\\n"}')))).toBe(digest(canonicalDigest({ "é": "snowman ☃\n" })));
});
test("safe integers use shortest decimal without exponent", () => {
  expect(value(canonicalJson(1e6))).toBe("1000000");
});
test("signed zero canonicalizes to unsigned zero", () => {
  expect(value(canonicalJson(-0))).toBe("0");
  expect(digest(canonicalDigest(-0))).toBe(digest(canonicalDigest(0)));
});
test("largest safe integer is retained exactly", () => {
  expect(value(canonicalJson(Number.MAX_SAFE_INTEGER))).toBe("9007199254740991");
});
test("non-integers use one plain decimal form", () => {
  expect(value(canonicalJson(1.25e-7))).toBe("0.000000125");
});
test("non-integers that need more than 15 significant digits are refused", () => {
  const result = canonicalJson(0.30000000000000004);
  expect(result.ok).toBe(false);
});
test("all returned digests carry the algorithm tag", () => {
  type DigestExports = {
    [Name in keyof typeof canonicalModule as ReturnType<(typeof canonicalModule)[Name]> extends Result<CanonicalDigest, unknown>
      ? Name : never]: (typeof canonicalModule)[Name]
  };
  // A new digest-returning export must be added here or this test stops typechecking.
  const digestExports: DigestExports = { canonicalDigest };
  const exportedFunctions = Object.entries(canonicalModule).filter(([, exported]) => typeof exported === "function");
  expect(Object.keys(digestExports).length).toBeGreaterThan(0);
  for (const [name] of exportedFunctions) {
    const exported = digestExports[name as keyof DigestExports];
    if (exported) expect(digest(exported({ value: 3.5 }))).toMatch(/^canonical-json\/v1:[a-f0-9]{64}$/);
  }
});

