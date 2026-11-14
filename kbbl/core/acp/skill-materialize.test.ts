import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { materializeSessionSkill } from "./skill-materialize";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(digest: string | null) {
  const root = mkdtempSync(join(tmpdir(), "session-skill-"));
  roots.push(root);
  return { digest, skillStoreRoot: resolve(import.meta.dir, "../../../workflow-config/definitions/skills"), sessionSkillsRoot: root, sid: "session-1" };
}
const digest = "8199a2589e1e69ded71370f990e7ac3e9ac48d6dc2137bad004d507de0b7280c";
test("verified bundle is reproduced identically in both external discovery layouts", () => {
  const spec = input(digest);
  const result = materializeSessionSkill(spec);
  expect(result.ok).toBe(true);
  for (const container of [".claude", ".agents"]) {
    expect(readFileSync(join(spec.sessionSkillsRoot, spec.sid, container, "skills/pr-operations/SKILL.md")))
      .toEqual(readFileSync(join(spec.skillStoreRoot, digest, "SKILL.md")));
  }
  expect(materializeSessionSkill(spec)).toEqual(result);
});
test("tampered bundle writes nothing", () => {
  const spec = input(digest);
  const store = join(spec.sessionSkillsRoot, "store");
  mkdirSync(join(store, digest), { recursive: true });
  writeFileSync(join(store, digest, "SKILL.md"), "tampered");
  const result = materializeSessionSkill({ ...spec, skillStoreRoot: store });
  expect(result.ok ? null : result.error.code).toBe("skill_unavailable");
  expect(existsSync(join(spec.sessionSkillsRoot, spec.sid))).toBe(false);
});
test("unknown bundle returns a typed error naming the digest", () => {
  const digest = "0".repeat(64);
  const spec = input(digest);
  const result = materializeSessionSkill(spec);
  expect(result.ok ? null : result.error.detail).toContain(digest);
  expect(existsSync(join(spec.sessionSkillsRoot, spec.sid))).toBe(false);
});
test("legacy null digest creates no directory", () => {
  const spec = input(null);
  expect(materializeSessionSkill(spec)).toEqual({ ok: true, value: { directory: null } });
  expect(existsSync(join(spec.sessionSkillsRoot, spec.sid))).toBe(false);
});
