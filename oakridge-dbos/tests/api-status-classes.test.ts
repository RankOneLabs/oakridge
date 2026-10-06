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
  const result = await capabilities.check_github({ forge: { owner: "owner", name: "repo" } });
  expect(result.ok ? null : result.error.detail).toBe("repository pull-request read denied (403)");
});
