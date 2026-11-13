import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "canonical-json";
import { createGradingConfigStore } from "../src/grading/configuration-store";
import { committedDefinitions } from "./grading-fixture";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grading-config-"));
  roots.push(root);
  return { root, store: createGradingConfigStore(root) };
}
const definitions = await committedDefinitions();
const input = { definitions, published_at: "2026-11-01T00:00:00Z" };

test("read-only calls leave a missing root absent", async () => {
  const { root } = await fixture();
  const store = createGradingConfigStore(join(root, "not-created"));
  expect(await store.readDraft()).toEqual({ ok: true, value: null });
  expect(await store.readVersion(1)).toEqual({ ok: true, value: null });
  expect(await store.listVersions()).toEqual({ ok: true, value: [] });
  expect(await store.latestVersion()).toEqual({ ok: true, value: null });
  expect(await readdir(root)).toEqual([]);
});
test("read-only calls leave a missing versions directory absent", async () => {
  const { root, store } = await fixture();
  const saved = await store.saveDraft(null, { status: "draft", definitions: [] });
  expect(await store.readDraft()).toEqual(saved);
  expect(await store.readVersion(1)).toEqual({ ok: true, value: null });
  expect(await store.listVersions()).toEqual({ ok: true, value: [] });
  expect(await store.latestVersion()).toEqual({ ok: true, value: null });
  expect(await readdir(root)).toEqual(["draft.json"]);
});
test("a symbolic-link root is rejected without reading or writing its target", async () => {
  const { root } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "grading-outside-")); roots.push(outside);
  const target = createGradingConfigStore(outside);
  const saved = await target.saveDraft(null, { status: "draft", definitions: [] });
  if (!saved.ok) throw new Error(saved.error.detail);
  await symlink(outside, join(root, "linked-root"));
  const store = createGradingConfigStore(join(root, "linked-root"));
  for (const result of [await store.readDraft(), await store.readVersion(1), await store.listVersions(),
    await store.latestVersion(), await store.saveDraft(null, { status: "draft", definitions: ["changed"] }),
    await store.allocateAndWritePublished(input)])
    expect(result).toMatchObject({ ok: false, error: { kind: "io" } });
  expect(await target.readDraft()).toEqual(saved);
  expect(await readdir(outside)).toEqual(["draft.json"]);
});

test("repeated draft saves return document digests and create no published versions", async () => {
  const { root, store } = await fixture();
  expect(await store.readDraft()).toEqual({ ok: true, value: null });
  const document = { status: "draft", definitions: [{ id: "incomplete" }] } as const;
  const first = await store.saveDraft(null, document);
  if (!first.ok) throw new Error(first.error.detail);
  const digest = canonicalDigest(document);
  if (!digest.ok) throw new Error(digest.error.detail);
  expect(first.value.digest).toBe(digest.value);
  expect((await store.saveDraft(first.value.digest, { status: "draft", definitions: [] })).ok).toBe(true);
  expect(await readdir(root)).toEqual(["draft.json"]);
});
test("a stale draft token carries the current digest and preserves the saved draft", async () => {
  const { store } = await fixture();
  const first = await store.saveDraft(null, { status: "draft", definitions: [] });
  if (!first.ok) throw new Error(first.error.detail);
  expect(await store.saveDraft(null, { status: "draft", definitions: ["lost update"] })).toMatchObject({
    ok: false, error: { kind: "draft_conflict", current_digest: first.value.digest },
  });
  expect(await store.readDraft()).toEqual(first);
});
test("concurrent publishers allocate sequential versions without changing earlier bytes", async () => {
  const { root, store } = await fixture();
  expect(await store.allocateAndWritePublished(input)).toMatchObject({ ok: true, value: { version: 1 } });
  const first = await readFile(join(root, "versions/000001.json"), "utf8");
  const results = await Promise.all([store.allocateAndWritePublished(input), store.allocateAndWritePublished(input)]);
  expect(results).toMatchObject([{ ok: true, value: { version: 2 } }, { ok: true, value: { version: 3 } }]);
  expect(await readFile(join(root, "versions/000001.json"), "utf8")).toBe(first);
  expect(await store.latestVersion()).toMatchObject({ ok: true, value: { version: 3 } });
});
test("latest uses only six-digit version names and ignores temp files and stray names", async () => {
  const { root, store } = await fixture();
  expect(await store.latestVersion()).toEqual({ ok: true, value: null });
  const first = await store.allocateAndWritePublished(input);
  if (!first.ok) throw new Error(first.error.detail);
  await writeFile(join(root, "versions/000010.json"), JSON.stringify({ ...first.value, version: 10 }));
  for (const name of ["999999.json.tmp", ".tmp-interrupted", "1000000.json", "11.json", "active.json"])
    await writeFile(join(root, "versions", name), "not a document");
  expect(await store.listVersions()).toEqual({ ok: true, value: [1, 10] });
  expect(await store.latestVersion()).toMatchObject({ ok: true, value: { version: 10 } });
  expect(await store.allocateAndWritePublished(input)).toMatchObject({ ok: true, value: { version: 11 } });
});
test("invalid version numbers cannot become file paths", async () => {
  const { store } = await fixture();
  for (const version of [NaN, Infinity, -1, 0, 1.5, 1000000])
    expect(await store.readVersion(version)).toMatchObject({ ok: false, error: { kind: "invalid_version" } });
});
test("concurrent draft saves with the same token accept only one writer", async () => {
  const { store } = await fixture();
  const results = await Promise.all([store.saveDraft(null, { status: "draft", definitions: [1] }), store.saveDraft(null, { status: "draft", definitions: [2] })]);
  expect(results.map((result) => result.ok)).toEqual([true, false]);
});
test("corrupted published content is refused", async () => {
  const { root, store } = await fixture();
  const first = await store.allocateAndWritePublished(input);
  if (!first.ok) throw new Error(first.error.detail);
  await writeFile(join(root, "versions/000001.json"), JSON.stringify({ ...first.value, hash: "tampered" }));
  expect(await store.latestVersion()).toMatchObject({ ok: false, error: { kind: "invalid_document" } });
});
test("symbolic links cannot redirect the versions directory outside the root", async () => {
  const { root, store } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "grading-outside-")); roots.push(outside);
  await symlink(outside, join(root, "versions"));
  expect((await store.allocateAndWritePublished(input)).ok).toBe(false);
  expect(await readdir(outside)).toEqual([]);
});
test("a stored JSON null is corrupt rather than an absent draft", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "draft.json"), "null");
  expect(await store.readDraft()).toMatchObject({ ok: false, error: { kind: "invalid_document" } });
});
