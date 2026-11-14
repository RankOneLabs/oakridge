import { expect, test } from "bun:test";
import { parsePrIntegration } from "../src/domain/pr-integration";
import { parseRunConfig } from "../src/domain/run-config";

test("integration parser accepts only exact integration names", () => {
  expect(["gated-review", "github-cli", "none", "GitHub-CLI", "gated_review", "", 42].map(parsePrIntegration))
    .toEqual(["gated-review", "github-cli", "none", null, null, null, null]);
});
test("legacy run settings keep gated-review without a skill", () => {
  expect(parseRunConfig({ sessions: {}, grading_enabled: false })).toEqual({ sessions: {}, grading_enabled: false,
    pr_integration: "gated-review", pr_skill_digest: null });
});
test("unknown recorded integrations are malformed", () => {
  expect(parseRunConfig({ pr_integration: "bogus" })).toBeNull();
});

import { parseLaunchRequest } from "../src/http/ingress";
import { readSkillBundle, readSkillIndex } from "../src/runtime/definition-store";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
test("launch accepts a top-level selection but rejects server-owned config keys", () => {
  const base = { request_id: "test", definition_id: "0".repeat(64), input: {} };
  expect([
    parseLaunchRequest({ ...base, pr_integration: "github-cli" }).ok,
    parseLaunchRequest({ ...base, pr_integration: "bogus" }).ok,
    parseLaunchRequest({ ...base, config: { pr_integration: "none" } }).ok,
    parseLaunchRequest({ ...base, config: { pr_skill_digest: null } }).ok,
  ]).toEqual([true, false, false, false]);
});
test("bundle reader verifies pinned bytes and detects tampering", () => {
  const index = readSkillIndex();
  if (!index.ok) throw new Error(JSON.stringify(index.error));
  const root = mkdtempSync(resolve(tmpdir(), "pr-skills-"));
  try {
    const digest = index.value["github-cli"];
    cpSync(resolve(import.meta.dir, "../../workflow-config/definitions/skills"), resolve(root, "skills"), { recursive: true });
    expect(readSkillBundle(digest, root).ok).toBe(true);
    writeFileSync(resolve(root, "skills", digest, "SKILL.md"), "tampered");
    const result = readSkillBundle(digest, root);
    expect(result.ok ? null : result.error.kind).toBe("hash_mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("authority config is never updated after launch", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/storage/commit.ts"), "utf8");
  expect(source).not.toMatch(/updateTable\("authority\.run"\)[\s\S]*?\.set\(\{\s*config\s*:/);
});
test("recorded integration and digest survive config parsing unchanged", () => {
  const config = { sessions: {}, grading_enabled: false, pr_integration: "github-cli" as const, pr_skill_digest: "pinned" };
  expect(parseRunConfig(config)).toEqual(config);
});
test("malformed digests are rejected", () => {
  expect(parseRunConfig({ pr_integration: "github-cli", pr_skill_digest: 42 })).toBeNull();
});
