import { expect, test } from "bun:test";
import { canonicalDigest } from "canonical-json";
import { configurationHash, parseConfigurationDocument, parseGradingDefinitions } from "../src/grading/configuration";
import { committedDefinitions, oakridgeGradingRegistry } from "./grading-fixture";

const definitions = await committedDefinitions();
const hash = configurationHash(definitions);
if (!hash.ok) throw new Error(hash.error.detail);
const published = { status: "published", version: 1, hash: hash.value, published_at: "2026-11-01T00:00:00Z", definitions } as const;

test("incomplete and empty drafts save without validating definitions", () => {
  for (const definitions of [[], [{ id: "unfinished" }], [null, "unfinished", 1]])
    expect(parseConfigurationDocument({ status: "draft", definitions }, oakridgeGradingRegistry).ok).toBe(true);
});
test("published documents validate the existing definitions", () => {
  expect(parseConfigurationDocument(published, oakridgeGradingRegistry)).toEqual({ ok: true, value: published });
});
test("an incomplete published definition is rejected", () => {
  expect(parseConfigurationDocument({ ...published, definitions: [{ id: "unfinished" }] }, oakridgeGradingRegistry).ok).toBe(false);
});
test("both wrappers reject unknown fields and published metadata is required", () => {
  for (const raw of [{ status: "draft", definitions: [], version: 1 }, { ...published, active: true },
    { ...published, version: 0 }, { ...published, published_at: "yesterday" }])
    expect(parseConfigurationDocument(raw, oakridgeGradingRegistry).ok).toBe(false);
});
test("the original strict array parser still rejects bookkeeping, empty arrays and wrappers", () => {
  for (const raw of [[], published, [{ ...definitions[0], version: 1 }]])
    expect(parseGradingDefinitions(raw, oakridgeGradingRegistry).ok).toBe(false);
});
test("configuration hash is canonicalDigest of the definitions only", () => {
  expect(configurationHash(definitions)).toEqual(canonicalDigest(definitions));
  expect(configurationHash([...definitions].reverse())).not.toEqual(hash);
  const later = { ...published, version: 2, published_at: "2026-11-02T00:00:00Z" };
  expect(parseConfigurationDocument(later, oakridgeGradingRegistry).ok).toBe(true);
});
test("published content with a mismatched recorded hash fails", () => {
  expect(parseConfigurationDocument({ ...published, hash: "wrong" }, oakridgeGradingRegistry)).toMatchObject({
    ok: false, error: { kind: "hash_mismatch" },
  });
});
test("hash failures remain Result values", () => {
  expect(configurationHash([NaN]).ok).toBe(false);
});
test("published definitions also retain semantic registry validation", () => {
  const invalid = [{ ...definitions[0]!, evidence: ["unregistered"] }];
  const digest = configurationHash(invalid); if (!digest.ok) throw new Error(digest.error.detail);
  expect(parseConfigurationDocument({ ...published, definitions: invalid, hash: digest.value }, oakridgeGradingRegistry)).toMatchObject({
    ok: false, error: { kind: "invalid_configuration", issues: [{ definition_index: 0, path: [0, "evidence"] }] },
  });
});
