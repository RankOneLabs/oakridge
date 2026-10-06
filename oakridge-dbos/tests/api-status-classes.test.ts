import { expect, test } from "bun:test";
import { Hono } from "hono";
import { httpBodyLimit } from "../src/http/app";
import { commandStatus, ConflictError, InternalFaultError, InvalidPayloadError, MalformedRequestError, MissingEntityError, PendingWork, TransientServiceError } from "../src/http/scope-commands";

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
