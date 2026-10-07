import { expect, test } from "bun:test";
import { Hono } from "hono";
import { httpBodyLimit } from "../src/http/app";
import { commandStatus, ConflictError, InternalFaultError, InvalidPayloadError, MalformedRequestError, MissingEntityError, PendingWork, TransientServiceError } from "../src/http/scope-commands";
import { resolve } from "node:path";
import type { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { githubProviderCapabilities } from "../src/runtime/compose";
import { createMutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

const definition: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
function capabilityInput(input: unknown, field = "repository") {
  const bundle = structuredClone(definition);
  bundle.schemas.push({ key: "capability_input", shape: { kind: "record", dictionary: null,
    fields: [{ key: field, schema: "forge_config", required: true }] } });
  return { bundle: { ...bundle, scopes: bundle.scopes.map((scope) => scope.key === bundle.root ? { ...scope, input_schema: "capability_input" } : scope) }, input };
}

test("every command outcome has a distinct status class", () => {
  const failures = [
    [new MalformedRequestError("bad JSON"), 400],
    [new InvalidPayloadError("bad schema"), 422],
    [new MissingEntityError("missing"), 404],
    [new ConflictError("stale"), 409],
    [new TransientServiceError("unavailable"), 503],
    [new InternalFaultError("broken"), 500],
  ] as const;
  for (const [error, status] of failures) expect(commandStatus({ ok: false, error })).toBe(status);
  expect(commandStatus({ ok: true, value: new PendingWork("request", "transition", 2) })).toBe(202);
  expect((failures[5][0] as InternalFaultError).trace_id).toBeTruthy();
});

test("the backend rejects a two MiB body with a typed 413", async () => {
  const app = new Hono();
  app.use("*", httpBodyLimit());
  app.post("/runs", (context) => context.json({ kind: "unexpected" }));
  const response = await app.request("/runs", { method: "POST", body: "x".repeat(2 * 1024 * 1024) });
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 413,
    body: { kind: "oversized_payload", limit: 1_048_576 } });
});

test("GitHub capability is checked before the mutation-service definition insert", async () => {
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
  const core = { request: async () => ({ ok: true, value: { kind: "compiled", value: { scopes: [], digest: "test" } } }) } as unknown as CoreClient;
  let inserted = false;
  const db = { transaction: async () => { inserted = true; throw new Error("unexpected insert"); } } as unknown as TransactionalSqlExecutor;
  const mutations = createMutationService(db, core, githubProviderCapabilities(""));
  const result = await mutations.startRun({ bundle, input: {} });
  expect({ inserted, detail: result.ok ? "" : result.error.detail }).toEqual({ inserted: false, detail: "missing provider capability: github token is absent" });
});

test("a token denied pull-request read is rejected at pin time", async () => {
  const capabilities = githubProviderCapabilities("restricted-token", (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch);
  const result = await capabilities.check_github(capabilityInput({ repository: { owner: "owner", name: "repo" } }));
  expect(result.ok ? null : result.error.detail).toBe("repository pull-request read denied (403)");
});

test("the capability check follows renamed schema fields, never /user", async () => {
  const urls: string[] = [];
  const capabilities = githubProviderCapabilities("token", (async (input: string | URL | Request) => { urls.push(String(input)); return new Response("[]", { status: 200 }); }) as unknown as typeof fetch);
  const result = await capabilities.check_github(capabilityInput({ renamed_repository: { owner: "RankOneLabs", name: "oakridge" } }, "renamed_repository"));
  expect({ ok: result.ok, urls }).toEqual({ ok: true, urls: ["https://api.github.com/repos/RankOneLabs/oakridge/pulls?per_page=1"] });
});

test("an input naming no GitHub repository fails the capability check closed", async () => {
  let called = false;
  const capabilities = githubProviderCapabilities("token", (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch);
  const result = await capabilities.check_github({ bundle: definition, input: { repositories: [{ key: "oakridge", preparation: { repository_path: "/repo" } }] } });
  expect({ called, detail: result.ok ? null : result.error.detail }).toEqual({ called: false, detail: "run input names no GitHub repository to check" });
});

test("schema traversal checks nested list repositories once and ignores undeclared fields", async () => {
  const urls: string[] = [];
  const capabilities = githubProviderCapabilities("token", (async (input: string | URL | Request) => {
    urls.push(String(input)); return new Response("[]", { status: 200 });
  }) as typeof fetch);
  const repository = { forge: { owner: "RankOneLabs", name: "oakridge" } };
  const result = await capabilities.check_github({ bundle: definition, input: {
    repositories: [repository, repository], undeclared: { owner: "ignored", name: "ignored" },
  } });
  expect({ ok: result.ok, urls }).toEqual({ ok: true, urls: ["https://api.github.com/repos/RankOneLabs/oakridge/pulls?per_page=1"] });
});
