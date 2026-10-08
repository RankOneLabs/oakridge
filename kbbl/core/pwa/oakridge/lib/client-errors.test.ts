import { expect, test } from "vitest";
import { selectFailureDetail } from "./client-errors";

test("the authority's {error, detail} answer surfaces the detail, not the bare kind", () => {
  expect(selectFailureDetail({ error: "conflict", detail: "scope version changed" }, "fallback")).toBe("scope version changed");
});

test("a {kind, detail} domain result surfaces the detail", () => {
  expect(selectFailureDetail({ kind: "active_conflict", detail: "run has an active attempt" }, "fallback"))
    .toBe("run has an active attempt");
});

test("a nested {error: {...}} body is read through", () => {
  expect(selectFailureDetail({ error: { kind: "invalid_payload", detail: "name is required" } }, "fallback"))
    .toBe("name is required");
});

test("a bare {error} or {kind} still names the failure when no detail exists", () => {
  expect(selectFailureDetail({ error: "offline" }, "fallback")).toBe("offline");
  expect(selectFailureDetail({ kind: "conflict" }, "fallback")).toBe("conflict");
});

test("an unreadable body yields the fallback", () => {
  expect(selectFailureDetail(null, "fallback")).toBe("fallback");
  expect(selectFailureDetail({ detail: "" }, "fallback")).toBe("fallback");
});
