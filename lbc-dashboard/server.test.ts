import { describe, expect, test } from "bun:test";

import {
  createApp,
  lbcResolveAuthPolicy,
  type LbcAuthPolicy,
} from "./server";
import { RunRegistry, type Launcher } from "./src/runs";

// Stub launcher so no Python process is spawned.
const stubLauncher: Launcher = {
  spawn: () => ({
    pid: 0,
    kill: () => {},
    done: Promise.resolve({ code: 0, stderrTail: "" }),
  }),
};

function buildApp(policy: LbcAuthPolicy) {
  return createApp({ registry: new RunRegistry(stubLauncher), authPolicy: policy });
}

// ---- lbcResolveAuthPolicy -------------------------------------------------

describe("lbcResolveAuthPolicy — startup guard", () => {
  test("127.0.0.1 without token is loopback mode", () => {
    const p = lbcResolveAuthPolicy({ host: "127.0.0.1", controlToken: undefined, allowInsecure: false });
    expect(p.mode).toBe("loopback");
  });

  test("0.0.0.0 without token or insecure flag throws", () => {
    expect(() => lbcResolveAuthPolicy({ host: "0.0.0.0", controlToken: undefined, allowInsecure: false }))
      .toThrow(/non-loopback bind/);
  });

  test("0.0.0.0 with ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 is insecure-non-loopback", () => {
    const p = lbcResolveAuthPolicy({ host: "0.0.0.0", controlToken: undefined, allowInsecure: true });
    expect(p.mode).toBe("insecure-non-loopback");
  });

  test("0.0.0.0 with token is token mode", () => {
    const p = lbcResolveAuthPolicy({ host: "0.0.0.0", controlToken: "secret", allowInsecure: false });
    expect(p).toEqual({ mode: "token", token: "secret" });
  });
});

// ---- middleware: loopback mode -------------------------------------------

describe("loopback mode", () => {
  const app = buildApp({ mode: "loopback" });

  test("GET /api/runs passes through without auth", async () => {
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
  });

  test("POST /api/runs passes through without auth (loopback)", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "does-not-exist", models: [], frames: 1 }),
    });
    // Auth passed — handler may reject the body for other reasons, but not 401/403.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("DELETE /api/runs/:id passes without auth (loopback)", async () => {
    const res = await app.request("/api/runs/unknown-id", { method: "DELETE" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ---- middleware: insecure-non-loopback mode --------------------------------

describe("insecure-non-loopback mode", () => {
  const app = buildApp({ mode: "insecure-non-loopback" });

  test("POST passes without auth in insecure mode", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x", models: [], frames: 1 }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ---- middleware: token mode -----------------------------------------------

const TOKEN = "dashboard-secret";

describe("token mode — GET passes without auth", () => {
  const app = buildApp({ mode: "token", token: TOKEN });

  test("GET /api/runs needs no auth", async () => {
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
  });

  test("GET /api/cells needs no auth", async () => {
    const res = await app.request("/api/cells");
    expect(res.status).toBe(200);
  });
});

describe("token mode — write routes require auth", () => {
  const app = buildApp({ mode: "token", token: TOKEN });

  test("POST /api/runs without credentials returns 401", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x", models: [], frames: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("DELETE /api/runs/:id without credentials returns 401", async () => {
    const res = await app.request("/api/runs/some-id", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("POST /api/runs with wrong token returns 403", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ task: "x", models: [], frames: 1 }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("POST /api/runs with correct token passes auth", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ task: "x", models: [], frames: 1 }),
    });
    // Not a 401 or 403 — auth passed (handler may reject the task).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("DELETE /api/runs/:id with correct token passes auth", async () => {
    const res = await app.request("/api/runs/some-id", {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Not 401/403 — auth passed (handler returns 404 for unknown id).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("write with correct cookie token passes auth", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `lbc_ctrl=${TOKEN}`,
      },
      body: JSON.stringify({ task: "x", models: [], frames: 1 }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("write with malformed Authorization header returns 401", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Basic dXNlcjpwYXNz",
      },
      body: JSON.stringify({ task: "x", models: [], frames: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

// ---- POST /auth/cookie ----------------------------------------------------

describe("POST /auth/cookie — token mode", () => {
  const app = buildApp({ mode: "token", token: TOKEN });

  test("missing auth returns 401", async () => {
    const res = await app.request("/auth/cookie", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("wrong token returns 403", async () => {
    const res = await app.request("/auth/cookie", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(403);
  });

  test("correct token sets HttpOnly SameSite=Lax cookie", async () => {
    const res = await app.request("/auth/cookie", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("lbc_ctrl=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
