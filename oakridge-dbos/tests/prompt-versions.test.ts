import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { CoreClient } from "../src/core-client/client";
import { DEFINITION_STORE_ROOT, readLaunchableCatalog, readPromptPointer, resolveDefinition, writeStoreFile, bytesIdentity } from "../src/runtime/definition-store";
import { listPromptVersions, savePendingPrompt, publishPrompt, validatePrompt } from "../src/runtime/prompt-versions";
import { installPromptVersions, type PromptVersionListing, type PromptPublicationOutcome, type PromptVersionErrorKind } from "../src/http/prompt-versions";
import { installReadModels } from "../src/http/read-models";
import { createHttpApp, type DefinitionApiDependencies } from "../src/http/app";
import { browserWritePolicy } from "../src/http/browser-write-policy";
import type { DefinitionDetail, DefinitionPage } from "../src/projections/definition-view";
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
test("publishing a shared prompt moves both workflows and preserves their pinned definitions", async () => {
  const { root, core } = fixture(); const path = "development/merge-confirmation.md";
  const before = unwrap(listPromptVersions(path));
  const catalogBytes = readFileSync(resolve(root, "launchable.json"));
  const pending = unwrap(await savePendingPrompt({ path, body: before.published.body + "\nAdditional guidance.\n", expected_pending_version_id: null }));
  expect(readFileSync(resolve(root, "launchable.json"))).toEqual(catalogBytes);
  const outcome = unwrap(await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: before.published.version_id }));
  expect(outcome.moved.map(move => move.workflow).sort()).toEqual(["development", "study"]);
  const after = unwrap(listPromptVersions(path));
  expect(after).toMatchObject({ pending: null, published: { body: pending.body, published_at: outcome.published_at } });
  expect(after.versions).toHaveLength(2);
  const catalog = unwrap(readLaunchableCatalog());
  for (const move of outcome.moved) {
    const previous = before.referenced_by.find(reference => reference.workflow === move.workflow);
    expect(move).toMatchObject({ workflow_name: move.workflow, audience: "user", previous_definition_id: previous?.definition_id });
    expect(move.definition_id).not.toBe(move.previous_definition_id);
    const old = unwrap(resolveDefinition(move.previous_definition_id));
    const next = unwrap(resolveDefinition(move.definition_id));
    expect(old.prompts[path]).toBe(before.published.body);
    expect(next.prompts).toEqual({ ...old.prompts, [path]: pending.body });
    expect(catalog[move.workflow]).toEqual({ definition_id: move.definition_id, audience: "user" });
  }
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
  expect(httpListing).toMatchObject({ source_path: path, published: { body: definition.prompt_sources[path], status: "published" }, pending: null,
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
test("immutable writes refuse differing bytes", () => {
  const { root, core } = fixture(); const bytes = Buffer.from("one"); const path = "prompts/" + bytesIdentity(bytes) + ".md";
  expect(writeStoreFile({ root, path, bytes }).ok).toBe(true);
  expect(writeStoreFile({ root, path, bytes: Buffer.from("two") }).ok).toBe(false);
  expect(readFileSync(resolve(root, path))).toEqual(bytes); core.close();
});
test("publishing an included prompt moves every workflow that includes it and re-expands the prompts that do", async () => {
  const { core } = fixture(); const path = "shared/raise-blocker.md";
  const before = unwrap(listPromptVersions(path));
  const body = "Raise a blocker when only the operator can settle the inputs.\n";
  const pending = unwrap(await savePendingPrompt({ path, body, expected_pending_version_id: null }));
  const outcome = unwrap(await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: before.published.version_id }));
  expect(outcome.moved.map(move => move.workflow).sort()).toEqual(["development", "study"]);
  const development = outcome.moved.find(move => move.workflow === "development");
  if (!development) throw new Error("development did not move");
  const old = unwrap(resolveDefinition(development.previous_definition_id));
  const next = unwrap(resolveDefinition(development.definition_id));
  expect({ authored: next.prompt_sources["development/build.md"], included: next.prompt_sources[path],
    expanded: next.prompts["development/build.md"] })
    .toEqual({ authored: old.prompt_sources["development/build.md"], included: body,
      expanded: old.prompts["development/build.md"].replace(before.published.body.trimEnd(), body.trimEnd()) });
  core.close();
});
test("a candidate that includes a missing prompt, or includes itself, is refused for every workflow it reaches", async () => {
  const { core } = fixture(); const path = "shared/raise-blocker.md";
  const missing = await validatePrompt(core, { path, body: "{{> shared/absent.md}}\n" });
  const cycle = await validatePrompt(core, { path, body: "{{> shared/raise-blocker.md}}\n" });
  expect([missing, cycle].map(result => result.ok ? null : { kind: result.error.kind, workflows: result.error.issues.map(issue => issue.workflow).sort() }))
    .toEqual([{ kind: "invalid_prompt", workflows: ["development", "study"] }, { kind: "invalid_prompt", workflows: ["development", "study"] }]);
  core.close();
});
test("an edit may include a prompt its workflow did not read before", async () => {
  const { core } = fixture(); const path = "review-loop/write.md";
  const before = unwrap(listPromptVersions(path));
  const pending = unwrap(await savePendingPrompt({ path, body: before.published.body + "\n{{> shared/raise-blocker.md}}\n", expected_pending_version_id: null }));
  const outcome = unwrap(await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: before.published.version_id }));
  const next = unwrap(resolveDefinition(outcome.moved[0].definition_id));
  expect(next.prompts[path].endsWith("raise a blocker instead of guessing.\n")).toBe(true);
  expect(Object.keys(next.prompt_sources)).toContain("shared/raise-blocker.md");
  core.close();
});
test("a candidate whose included text names an input its workflow does not declare fails compilation", async () => {
  const { core } = fixture();
  const result = await validatePrompt(core, { path: "shared/raise-blocker.md", body: "Raise a blocker about {{ nonexistent }}.\n" });
  expect(!result.ok && result.error.issues.some(issue => issue.detail.includes("undeclared input nonexistent"))).toBe(true);
  core.close();
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

test("operator HTTP prompt readback preserves exact pending and published text", async () => {
  const { createHttpApp } = await import("../src/http/app");
  const { browserWritePolicy } = await import("../src/http/browser-write-policy");
  const { core } = fixture();
  const app = createHttpApp({ db: null as never, core, wake: () => {}, application_version: "test",
    access: { kind: "token_required", token: "operator-token" }, write_policy: browserWritePolicy([]) });
  const path = "development/brief.md";
  const headers = { authorization: "Bearer operator-token", "content-type": "application/json" };
  const read = () => app.request("/api/prompt-versions?path=development%2Fbrief.md", { headers });
  try {
    const initial = unwrap(listPromptVersions(path));
    const body = initial.published.body + "\r\nAuthorization: Bearer EXAMPLE_TOKEN\r\nUnicode: 雪\r\n";
    const saved = await app.request("/api/prompt-versions/pending", { method: "PUT", headers,
      body: JSON.stringify({ path, body, expected_pending_version_id: null }) });
    expect(saved.status).toBe(200);
    const pending = await saved.json() as import("../src/http/prompt-versions").PromptVersionView;
    expect(pending.body).toBe(body);
    const response = await read();
    expect(response.status).toBe(200);
    const listing = await response.json() as PromptVersionListing;
    expect(listing.pending?.body).toBe(body);
    expect(listing.versions.find(version => version.version_id === pending.version_id)?.body).toBe(body);
    expect(bytesIdentity(Buffer.from(listing.pending!.body))).toBe(pending.prompt_id);
    const published = await app.request("/api/prompt-versions/publish", { method: "POST", headers,
      body: JSON.stringify({ path, expected_pending_version_id: pending.version_id, expected_published_version_id: initial.published.version_id }) });
    expect(published.status).toBe(200);
    const after = await (await read()).json() as PromptVersionListing;
    expect(after.published.body).toBe(body);
    expect(after.versions.find(version => version.version_id === pending.version_id)?.body).toBe(body);
  } finally { core.close(); }
});

test("prompt body preservation keeps credential redaction in metadata, errors and other read routes", async () => {
  const { redactingReadResponses } = await import("../src/projections/serialization-view");
  const { core } = fixture();
  interface PromptListingDiagnostic extends PromptVersionListing {
    readonly publication_secret: string;
    readonly publication_secret_hash: string;
    readonly detail: string;
  }
  const path = "development/brief.md";
  const body = "Authorization: Bearer EXAMPLE_TOKEN";
  try {
    unwrap(await savePendingPrompt({ path, body, expected_pending_version_id: null }));
    const diagnostic: PromptListingDiagnostic = { ...unwrap(listPromptVersions(path)),
      publication_secret: "actual-server-secret", publication_secret_hash: "actual-secret-hash", detail: "Authorization: Bearer SERVER_CREDENTIAL" };
    const app = new Hono();
    app.use("*", redactingReadResponses());
    app.get("/api/prompt-versions", context => context.json(diagnostic));
    app.get("/api/diagnostics", context => context.json(diagnostic));
    const listing = await (await app.request("/api/prompt-versions")).json() as PromptListingDiagnostic;
    expect({ body: listing.pending?.body, secret: listing.publication_secret, hash: listing.publication_secret_hash, detail: listing.detail })
      .toEqual({ body, secret: "[REDACTED]", hash: "[REDACTED]", detail: "Authorization: Bearer [REDACTED]" });
    const other = await (await app.request("/api/diagnostics")).json() as PromptListingDiagnostic;
    expect({ body: other.pending?.body, secret: other.publication_secret, hash: other.publication_secret_hash })
      .toEqual({ body: "Authorization: Bearer [REDACTED]", secret: "[REDACTED]", hash: "[REDACTED]" });
    const errors = new Hono();
    errors.use("*", redactingReadResponses());
    installPromptVersions(errors, core);
    const response = await errors.request("/api/prompt-versions?path=" + encodeURIComponent("../Authorization: Bearer SERVER_CREDENTIAL"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { entity_id: "../Authorization: Bearer [REDACTED]" } });
  } finally { core.close(); }
});

test("definition detail served by the app keeps pinned prompt bodies byte-exact and still redacts errors", async () => {
  const { core } = fixture();
  const path = "development/brief.md";
  const body = "Send `Authorization: Bearer EXAMPLE_TOKEN` when calling the example API.";
  try {
    const pending = unwrap(await savePendingPrompt({ path, body, expected_pending_version_id: null }));
    const outcome = unwrap(await publishPrompt(core, { path, expected_pending_version_id: pending.version_id,
      expected_published_version_id: unwrap(listPromptVersions(path)).published.version_id }));
    const definition_id = outcome.moved[0].definition_id;
    const app = createHttpApp({ ...({} as DefinitionApiDependencies), application_version: "test",
      access: { kind: "loopback_open" }, write_policy: browserWritePolicy([]) });
    const response = await app.request("/api/definitions/" + definition_id);
    expect(response.status).toBe(200);
    const detail = await response.json() as DefinitionDetail;
    expect(detail.prompts[path]).toEqual({ body, digest: pending.prompt_id });
    const missing = await app.request("/api/definitions/" + encodeURIComponent("Authorization: Bearer SERVER_CREDENTIAL"));
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).not.toContain("SERVER_CREDENTIAL");
  } finally { core.close(); }
});

test("a publish whose pointer write fails leaves launchable.json on the previous definition", async () => {
  const { root, core } = fixture();
  const path = "development/brief.md";
  const pointerDirectory = resolve(root, "prompt-pointers", "development");
  try {
    const pending = unwrap(await savePendingPrompt({ path, body: "unwritable pointer body", expected_pending_version_id: null }));
    const published = unwrap(listPromptVersions(path)).published.version_id;
    const catalogBefore = readFileSync(resolve(root, "launchable.json"));
    const pointerBefore = readFileSync(resolve(pointerDirectory, "brief.md.json"));
    chmodSync(pointerDirectory, 0o555);
    const result = await publishPrompt(core, { path, expected_pending_version_id: pending.version_id, expected_published_version_id: published });
    chmodSync(pointerDirectory, 0o755);
    expect(result.ok).toBe(false);
    expect(readFileSync(resolve(root, "launchable.json")).equals(catalogBefore)).toBe(true);
    expect(readFileSync(resolve(pointerDirectory, "brief.md.json")).equals(pointerBefore)).toBe(true);
  } finally { chmodSync(pointerDirectory, 0o755); core.close(); }
});
