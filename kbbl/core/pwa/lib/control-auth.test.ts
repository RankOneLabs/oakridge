import { afterEach, expect, test, vi } from "vitest";
import { selectIsSignInRequired, signInWithToken } from "./control-auth";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("sign-in is asked for only when kbbl requires a credential the browser does not hold", () => {
  expect([
    selectIsSignInRequired(null),
    selectIsSignInRequired({ is_required: false, is_authenticated: true }),
    selectIsSignInRequired({ is_required: true, is_authenticated: true }),
    selectIsSignInRequired({ is_required: true, is_authenticated: false }),
  ]).toEqual([false, false, false, true]);
});

test("a token is exchanged as Bearer for the cookie, and a refusal is told apart from an outage", async () => {
  const sent: (string | null)[] = [];
  const answers = [new Response("{}", { status: 200 }), new Response("{}", { status: 403 }), new Response("{}", { status: 502 })];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("authorization"));
    return answers.shift()!;
  }) as unknown as typeof fetch;
  const results = [await signInWithToken("tok"), await signInWithToken("bad"), await signInWithToken("tok")];
  expect({ sent, results }).toEqual({ sent: ["Bearer tok", "Bearer bad", "Bearer tok"], results: [
    { ok: true, value: null }, { ok: false, error: { kind: "rejected" } }, { ok: false, error: { kind: "unavailable", detail: "kbbl answered 502" } }] });
});
