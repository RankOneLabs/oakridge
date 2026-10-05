import { expect, test } from "bun:test";
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
