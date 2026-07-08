import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  isLoopbackHost,
  makeControlAuthMiddleware,
  makeCookieHandler,
  resolveStartupAuthPolicy,
  type AuthPolicy,
} from "./auth";

// ---- resolveStartupAuthPolicy -----------------------------------------------

describe("resolveStartupAuthPolicy — startup guard", () => {
  test("127.0.0.1 without token starts successfully as loopback", () => {
    const policy = resolveStartupAuthPolicy({
      host: "127.0.0.1",
      controlToken: undefined,
      allowInsecure: false,
    });
    expect(policy.mode).toBe("loopback");
  });

  test("0.0.0.0 without token or insecure flag throws at startup", () => {
    expect(() =>
      resolveStartupAuthPolicy({
        host: "0.0.0.0",
        controlToken: undefined,
        allowInsecure: false,
      }),
    ).toThrow(/non-loopback bind/);
  });

  test("0.0.0.0 with ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 starts with insecure-non-loopback marker", () => {
    const policy = resolveStartupAuthPolicy({
      host: "0.0.0.0",
      controlToken: undefined,
      allowInsecure: true,
    });
    expect(policy.mode).toBe("insecure-non-loopback");
  });

  test("0.0.0.0 with OAKRIDGE_CONTROL_TOKEN starts in token mode", () => {
    const policy = resolveStartupAuthPolicy({
      host: "0.0.0.0",
      controlToken: "s3cr3t",
      allowInsecure: false,
    });
    expect(policy).toEqual({ mode: "token", token: "s3cr3t" });
  });

  test("::1 without token is treated as loopback", () => {
    const policy = resolveStartupAuthPolicy({
      host: "::1",
      controlToken: undefined,
      allowInsecure: false,
    });
    expect(policy.mode).toBe("loopback");
  });

  test("localhost without token is treated as loopback", () => {
    const policy = resolveStartupAuthPolicy({
      host: "localhost",
      controlToken: undefined,
      allowInsecure: false,
    });
    expect(policy.mode).toBe("loopback");
  });

  test("concrete LAN address without token or insecure flag throws", () => {
    expect(() =>
      resolveStartupAuthPolicy({
        host: "192.168.1.100",
        controlToken: undefined,
        allowInsecure: false,
      }),
    ).toThrow();
  });

  test("tailnet address with token resolves to token mode", () => {
    const policy = resolveStartupAuthPolicy({
      host: "100.64.0.1",
      controlToken: "my-token",
      allowInsecure: false,
    });
    expect(policy).toEqual({ mode: "token", token: "my-token" });
  });

  test("whitespace-only token is treated as absent (throws on non-loopback)", () => {
    expect(() =>
      resolveStartupAuthPolicy({
        host: "0.0.0.0",
        controlToken: "   ",
        allowInsecure: false,
      }),
    ).toThrow();
  });
});

describe("isLoopbackHost", () => {
  test("recognizes IPv4 loopback", () => expect(isLoopbackHost("127.0.0.1")).toBe(true));
  test("recognizes IPv6 loopback", () => expect(isLoopbackHost("::1")).toBe(true));
  test("recognizes localhost", () => expect(isLoopbackHost("localhost")).toBe(true));
  test("rejects 0.0.0.0", () => expect(isLoopbackHost("0.0.0.0")).toBe(false));
  test("rejects LAN address", () => expect(isLoopbackHost("192.168.1.1")).toBe(false));
});

// ---- makeControlAuthMiddleware -----------------------------------------------

function buildApp(policy: AuthPolicy): Hono {
  const app = new Hono();
  app.use("/*", makeControlAuthMiddleware(policy));
  app.get("/read", (c) => c.json({ ok: true }));
  app.post("/write", (c) => c.json({ ok: true }));
  app.delete("/write", (c) => c.json({ ok: true }));
  app.post("/hook/approval", (c) => c.json({ ok: true }));
  return app;
}

describe("makeControlAuthMiddleware — loopback mode", () => {
  const app = buildApp({ mode: "loopback" });

  test("GET passes through without auth", async () => {
    const res = await app.request("/read");
    expect(res.status).toBe(200);
  });

  test("POST passes through without auth", async () => {
    const res = await app.request("/write", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("makeControlAuthMiddleware — insecure-non-loopback mode", () => {
  const app = buildApp({ mode: "insecure-non-loopback" });

  test("POST passes through without auth", async () => {
    const res = await app.request("/write", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("makeControlAuthMiddleware — token mode", () => {
  const TOKEN = "test-secret-token";
  const app = buildApp({ mode: "token", token: TOKEN });

  test("GET passes through without auth", async () => {
    const res = await app.request("/read");
    expect(res.status).toBe(200);
  });

  test("POST /hook/* passes through without auth (loopback-verified adapter)", async () => {
    const res = await app.request("/hook/approval", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("POST without credentials returns 401 with WWW-Authenticate", async () => {
    const res = await app.request("/write", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("POST with malformed Authorization header returns 401", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  test("POST with wrong Bearer token returns 403", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("POST with correct Bearer token succeeds", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("DELETE with correct Bearer token succeeds", async () => {
    const res = await app.request("/write", {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("POST with correct cookie token succeeds", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: `kbbl_ctrl=${TOKEN}; other=val` },
    });
    expect(res.status).toBe(200);
  });

  test("POST with wrong cookie token returns 403", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: "kbbl_ctrl=wrong-token" },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("POST with unrelated cookie (no kbbl_ctrl) returns 401", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: "session=abc123" },
    });
    expect(res.status).toBe(401);
  });
});

// ---- makeCookieHandler -------------------------------------------------------

describe("makeCookieHandler — loopback mode", () => {
  test("always returns ok without setting cookie", async () => {
    const app = new Hono();
    const policy: AuthPolicy = { mode: "loopback" };
    app.post("/auth/cookie", makeCookieHandler(policy));
    const res = await app.request("/auth/cookie", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("makeCookieHandler — token mode", () => {
  const TOKEN = "test-secret-token";

  function buildCookieApp(): Hono {
    const app = new Hono();
    const policy: AuthPolicy = { mode: "token", token: TOKEN };
    app.post("/auth/cookie", makeCookieHandler(policy));
    return app;
  }

  test("missing Authorization returns 401", async () => {
    const app = buildCookieApp();
    const res = await app.request("/auth/cookie", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  test("wrong token returns 403", async () => {
    const app = buildCookieApp();
    const res = await app.request("/auth/cookie", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(403);
  });

  test("correct token sets HttpOnly SameSite=Lax cookie", async () => {
    const app = buildCookieApp();
    const res = await app.request("/auth/cookie", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("kbbl_ctrl=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });
});
