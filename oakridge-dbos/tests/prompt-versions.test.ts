import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { CoreClient } from "../src/core-client/client";
import { DEFINITION_STORE_ROOT, readLaunchableCatalog, readPromptPointer, resolveDefinition, writeStoreFile, withPublishedPrompt, bytesIdentity } from "../src/runtime/definition-store";
import { listPromptVersions, savePendingPrompt, publishPrompt, validatePrompt } from "../src/runtime/prompt-versions";
import { installPromptVersions, type PromptVersionListing, type PromptPublicationOutcome, type PromptVersionErrorKind } from "../src/http/prompt-versions";
import { installReadModels } from "../src/http/read-models";
import type { DefinitionPage } from "../src/projections/definition-view";
import type { Result } from "canonical-json";
function unwrap<T,E>(result: Result<T,E>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const temporary: string[] = [];
const previousRoot = process.env.OAKRIDGE_DEFINITION_ROOT;
afterEach(() => { if (previousRoot === undefined) delete process.env.OAKRIDGE_DEFINITION_ROOT; else process.env.OAKRIDGE_DEFINITION_ROOT = previousRoot; for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-versions-")); temporary.push(root);
  cpSync(DEFINITION_STORE_ROOT, root, { recursive: true }); process.env.OAKRIDGE_DEFINITION_ROOT = root;
  return { root, core: unwrap(CoreClient.start()) };
}
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = resolve(entry.parentPath, entry.name); return [path, readFileSync(path).toString("base64")];
  }).sort());
}
test("save and publish moves development once, preserves audience and the pinned old definition", async () => {
  const { root, core } = fixture(); const path = "development/merge-confirmation.md";
  const before = unwrap(listPromptVersions(path));
  const catalogBytes = readFileSync(resolve(root, "launchable.json"));
  const pending = unwrap(await savePendingPrompt({ path, body: before.published.body + "\nAdditional guidance.\n", expected_pending_version_id: null }));
  expect(readFileSync(resolve(root, "launchable.json"))).toEqual(catalogBytes);
  const outcome = unwrap(await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: before.published.version_id }));
  expect(outcome.moved).toHaveLength(1);
  expect(outcome.moved[0]).toMatchObject({ workflow: "development", workflow_name: "development", audience: "user", previous_definition_id: before.referenced_by[0].definition_id });
  expect(outcome.moved[0].definition_id).not.toBe(outcome.moved[0].previous_definition_id);
  expect(resolveDefinition(outcome.moved[0].previous_definition_id).ok).toBe(true);
  const after = unwrap(listPromptVersions(path));
  expect(after).toMatchObject({ pending: null, published: { body: pending.body, published_at: outcome.published_at } });
  expect(after.versions).toHaveLength(2);
  const old = unwrap(resolveDefinition(outcome.moved[0].previous_definition_id));
  const next = unwrap(resolveDefinition(outcome.moved[0].definition_id));
  expect(next.prompts).toEqual({ ...old.prompts, [path]: pending.body });
  expect(unwrap(readLaunchableCatalog()).development.audience).toBe("user");
  core.close();
});
test("conflicts and invalid compilation write nothing", async () => {
  const { root, core } = fixture(); const path = "development/brief.md"; const listing = unwrap(listPromptVersions(path));
  const pending = unwrap(await savePendingPrompt({ path, body: "{{ nonexistent.required }}", expected_pending_version_id: null }));
  const before = snapshot(root);
  const conflict = await publishPrompt(core, { path, expected_pending_version_id: listing.published.version_id, expected_published_version_id: listing.published.version_id });
  expect(conflict.ok ? null : conflict.error.kind).toBe("pending_conflict");
  const publishedConflict = await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: pending.version_id });
  expect(publishedConflict.ok ? null : publishedConflict.error.kind).toBe("published_conflict");
  const invalid = await validatePrompt(core, { path, body: pending.body });
  expect(invalid.ok ? null : invalid.error).toMatchObject({ kind: "invalid_prompt", issues: [{ workflow: "development", path: ["development"] }] });
  const publication = await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: listing.published.version_id });
  expect(publication.ok ? null : publication.error.kind).toBe("invalid_prompt");
  expect(snapshot(root)).toBe(before); core.close();
});
test("HTTP list, save, validate and publish expose the version lifecycle", async () => {
  const { core } = fixture(); const app = new Hono(); installPromptVersions(app, core);
  // Definition listing reads the file store; no database queries are needed.
  installReadModels(app, { db: null as never });
  const path = "development/brief.md"; const listing = unwrap(listPromptVersions(path));
  const response = await app.request("/api/prompt-versions?path=development%2Fbrief.md");
  expect(response.status).toBe(200);
  const httpListing = await response.json() as PromptVersionListing;
  const definition = unwrap(resolveDefinition(unwrap(readLaunchableCatalog()).development.definition_id));
  expect(httpListing).toMatchObject({ source_path: path, published: { body: definition.prompts[path], status: "published" }, pending: null,
    referenced_by: [{ workflow: "development", workflow_name: "development", definition_id: definition.definition_id }] });
  const request = (url: string, method: string, body: unknown) => app.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await request("/api/prompt-versions/pending", "PUT", { path, body: listing.published.body + "\nNew guidance.\n", expected_pending_version_id: null })).status).toBe(200);
  const pending = unwrap(listPromptVersions(path)).pending!;
  expect((await request("/api/prompt-versions/validate", "POST", { path, body: pending.body })).status).toBe(200);
  const published = await request("/api/prompt-versions/publish", "POST", { path, expected_pending_version_id: pending.version_id, expected_published_version_id: listing.published.version_id });
  expect(published.status).toBe(200);
  const outcome = await published.json() as PromptPublicationOutcome;
  const definitionsResponse = await app.request("/api/definitions");
  expect(definitionsResponse.status).toBe(200);
  const definitions = await definitionsResponse.json() as DefinitionPage;
  expect(definitions.items.find(entry => entry.bundle.key === "development")?.definition_id).toBe(outcome.moved[0].definition_id);
  expect((await app.request("/api/prompt-versions?path=../bad")).status).toBe(400);
  expect((await app.request("/api/prompt-versions?path=missing.md")).status).toBe(404); core.close();
});
test("immutable writes refuse differing bytes and the prompt transform preserves other fields", () => {
  const { root, core } = fixture(); const bytes = Buffer.from("one"); const path = "prompts/" + bytesIdentity(bytes) + ".md";
  expect(writeStoreFile({ root, path, bytes }).ok).toBe(true);
  expect(writeStoreFile({ root, path, bytes: Buffer.from("two") }).ok).toBe(false);
  expect(readFileSync(resolve(root, path))).toEqual(bytes);
  const resolved = unwrap(resolveDefinition(unwrap(readLaunchableCatalog()).development.definition_id));
  const committed = { source: resolved.source, operation_registry_id: resolved.operation_registry_id, prompts: { "a.md": bytesIdentity(bytes) }, schema_names: resolved.schema_names, stage_names: resolved.stage_names };
  expect(withPublishedPrompt(committed, "a.md", bytesIdentity(Buffer.from("two")))).toEqual({ ...committed, prompts: { "a.md": bytesIdentity(Buffer.from("two")) } }); core.close();
});

test("all four prompt routes require the configured operator token", async () => {
  const { createHttpApp } = await import("../src/http/app");
  const { browserWritePolicy } = await import("../src/http/browser-write-policy");
  const { core } = fixture();
  const app = createHttpApp({ db: null as never, core, wake: () => {}, application_version: "test", access: { kind: "token_required", token: "secret" }, write_policy: browserWritePolicy([]) });
  for (const [method, path] of [["GET", ""], ["PUT", "/pending"], ["POST", "/validate"], ["POST", "/publish"]]) {
    expect((await app.request("/api/prompt-versions" + path, { method, headers: { "content-type": "application/json" } })).status).toBe(401);
  }
  core.close();
});

test("HTTP failures carry the complete prompt error contract and status", async () => {
  const { core } = fixture(); const app = new Hono(); installPromptVersions(app, core);
  const path = "development/brief.md";
  const listing = unwrap(listPromptVersions(path));
  const request = (route: string, body: unknown) => app.request("/api/prompt-versions/" + route, {
    method: route === "pending" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const assertError = async (response: Response, expected: { kind: PromptVersionErrorKind; status: number; entity_id: string; has_issues?: boolean }) => {
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual({ error: { operation: "prompt_versions", kind: expected.kind, entity_id: expected.entity_id,
      detail: expect.any(String), issues: expected.has_issues ? [{ workflow: "development", path: ["development"], detail: expect.any(String) }] : [] } });
  };
  await assertError(await app.request("/api/prompt-versions?path=../bad"), { kind: "invalid_path", status: 400, entity_id: "../bad" });
  await assertError(await app.request("/api/prompt-versions?path=missing.md"), { kind: "unknown_prompt", status: 404, entity_id: "missing.md" });
  await assertError(await request("publish", { path, expected_pending_version_id: null, expected_published_version_id: listing.published.version_id }),
    { kind: "no_pending", status: 409, entity_id: path });
  await assertError(await request("validate", { path, body: "{{ nonexistent.required }}" }),
    { kind: "invalid_prompt", status: 422, entity_id: path, has_issues: true });
  const pending = unwrap(await savePendingPrompt({ path, body: "{{ nonexistent.required }}", expected_pending_version_id: null }));
  await assertError(await request("pending", { path, body: "stale save", expected_pending_version_id: null }),
    { kind: "pending_conflict", status: 409, entity_id: path });
  await assertError(await request("publish", { path, expected_pending_version_id: listing.published.version_id, expected_published_version_id: listing.published.version_id }),
    { kind: "pending_conflict", status: 409, entity_id: path });
  await assertError(await request("publish", { path, expected_pending_version_id: pending.version_id, expected_published_version_id: pending.version_id }),
    { kind: "published_conflict", status: 409, entity_id: path });
  await assertError(await request("publish", { path, expected_pending_version_id: pending.version_id, expected_published_version_id: listing.published.version_id }),
    { kind: "invalid_prompt", status: 422, entity_id: path, has_issues: true });
  core.close();
});

test("restoring a published body uses its latest publication date and lists each version once", async () => {
  const { core } = fixture();
  const path = "development/brief.md";
  try {
    const initial = unwrap(listPromptVersions(path));
    const changed = unwrap(await savePendingPrompt({ path, body: initial.published.body + "\nTemporary guidance.\n", expected_pending_version_id: null }));
    unwrap(await publishPrompt(core, { path, expected_pending_version_id: changed.version_id, expected_published_version_id: initial.published.version_id }));
    const restored = unwrap(await savePendingPrompt({ path, body: initial.published.body, expected_pending_version_id: null }));
    const withPending = unwrap(listPromptVersions(path));
    expect(withPending.versions.map(version => [version.version_id, version.status])).toEqual([
      [changed.version_id, "published"], [initial.published.version_id, "pending"],
    ]);
    const outcome = unwrap(await publishPrompt(core, { path, expected_pending_version_id: restored.version_id, expected_published_version_id: changed.version_id }));
    const listing = unwrap(listPromptVersions(path));
    expect(listing.published).toMatchObject({ version_id: initial.published.version_id, body: initial.published.body, published_at: outcome.published_at });
    expect(listing.versions.map(version => [version.version_id, version.status, version.published_at])).toEqual([
      [initial.published.version_id, "published", outcome.published_at],
      [changed.version_id, "superseded", expect.any(String)],
    ]);
    const pointer = unwrap(readPromptPointer(path));
    expect(pointer.history).toEqual([
      { version_id: initial.published.version_id, published_at: null },
      { version_id: changed.version_id, published_at: expect.any(String) },
      { version_id: initial.published.version_id, published_at: outcome.published_at },
    ]);
  } finally { core.close(); }
});
