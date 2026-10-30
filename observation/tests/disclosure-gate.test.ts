import { expect, test } from "bun:test";
import { checkDisclosure, DISCLOSURE_POLICY_VERSION } from "../src/grading/disclosure";
import { evidence } from "./grading-fixture";

test("unclassified and restricted evidence is denied without exposing content", () => {
  for (const kind of [undefined, "internal", "raw_build_output", "raw_test_output"] as const) {
    const result = checkDisclosure({ ...evidence, references: [{ ref: "secret", kind,
      content: "do-not-log", digest: "digest" }] }, "provider");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do-not-log");
  }
});
test("permitted disclosure records policy, provider, digests and content types", () => {
  const result = checkDisclosure({ ...evidence, references: [{ ref: "public", kind: "public",
    content: "visible", digest: "digest-1" }] }, "provider");
  expect(result).toEqual({ ok: true, value: { provider: "provider", policy_version: DISCLOSURE_POLICY_VERSION,
    manifest_digests: ["digest-1"], content_types: ["public"] } });
});
