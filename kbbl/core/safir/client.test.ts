import { describe, expect, test } from "bun:test";

import { createSafirClient, SafirHttpError, type FetchFn } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createSafirClient happy path", () => {
  test("createRun returns parsed body", async () => {
    const fakeRun = { id: "r1", task_id: 1, status: "running" };
    const fetchFn: FetchFn = async () => jsonResponse(201, fakeRun);
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    const result = await client.createRun(1, { executor: "claude_code", status: "running" });
    expect(result).toEqual(fakeRun as never);
  });

  test("getTask returns parsed body", async () => {
    const fakeTask = {
      id: 7,
      project_id: "p",
      parent_id: null,
      title: "t",
      status: "open",
    };
    const fetchFn: FetchFn = async () => jsonResponse(200, fakeTask);
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    const result = await client.getTask(7);
    expect(result.id).toBe(7);
  });

  test("listTasks returns array body", async () => {
    const fetchFn: FetchFn = async () => jsonResponse(200, []);
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    const result = await client.listTasks();
    expect(result).toEqual([]);
  });
});

describe("createSafirClient error paths", () => {
  test("404 throws SafirHttpError with status + body", async () => {
    const errBody = { error: "not found" };
    const fetchFn: FetchFn = async () => jsonResponse(404, errBody);
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    let caught: unknown;
    try {
      await client.getTask(999);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafirHttpError);
    expect((caught as SafirHttpError).status).toBe(404);
    expect((caught as SafirHttpError).body).toEqual(errBody as never);
  });

  test("400 throws SafirHttpError", async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse(400, { error: "bad" });
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    await expect(client.getTask(1)).rejects.toBeInstanceOf(SafirHttpError);
  });

  test("500 throws SafirHttpError with status 500", async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse(500, { error: "boom" });
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    let caught: unknown;
    try {
      await client.getTask(1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafirHttpError);
    expect((caught as SafirHttpError).status).toBe(500);
  });

  test("network error re-throws as TypeError", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("simulated network down");
    };
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    await expect(client.getTask(1)).rejects.toBeInstanceOf(TypeError);
  });

  test("timeout aborts the request", async () => {
    const fetchFn: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            // Match what Node/Bun's native fetch does on abort: raise an
            // error that the client's caller can discriminate. Use a
            // DOMException-compatible AbortError if available; fall back
            // to a TypeError since some runtimes surface it that way.
            reject(
              typeof DOMException === "function"
                ? new DOMException("aborted", "AbortError")
                : new TypeError("aborted"),
            );
          });
        }
      });
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
      timeoutMs: 50,
    });
    let caught: unknown;
    const t0 = Date.now();
    try {
      await client.getTask(1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Abort happened in well under a second — proves the timer fired.
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("createSafirClient request shape", () => {
  test("Authorization header omitted when no apiToken", async () => {
    let captured: { url: string; headers: Headers } | null = null;
    const fetchFn: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      captured = { url, headers: new Headers(init?.headers) };
      return jsonResponse(200, []);
    };
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    await client.listTasks();
    expect(captured).not.toBeNull();
    expect(captured!.headers.get("authorization")).toBeNull();
  });

  test("Authorization header present when apiToken set", async () => {
    let captured: { headers: Headers } | null = null;
    const fetchFn: FetchFn = async (_input, init) => {
      captured = { headers: new Headers(init?.headers) };
      return jsonResponse(200, []);
    };
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      apiToken: "secret-token",
      fetch: fetchFn,
    });
    await client.listTasks();
    expect(captured!.headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("URL is composed without double-slash, even with trailing slash on base", async () => {
    let capturedUrl = "";
    const fetchFn: FetchFn = async (input) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      return jsonResponse(200, []);
    };
    const client = createSafirClient({
      baseUrl: "http://safir.test/",
      fetch: fetchFn,
    });
    await client.listTasks();
    expect(capturedUrl).toBe("http://safir.test/tasks");
  });

  test("POST sets content-type and body", async () => {
    let captured: { method: string; body: string; ct: string | null } | null =
      null;
    const fetchFn: FetchFn = async (_input, init) => {
      captured = {
        method: (init?.method as string) ?? "GET",
        body: (init?.body as string) ?? "",
        ct: new Headers(init?.headers).get("content-type"),
      };
      return jsonResponse(201, { id: "r" });
    };
    const client = createSafirClient({
      baseUrl: "http://safir.test",
      fetch: fetchFn,
    });
    await client.createRun(42, { executor: "claude_code", status: "running" });
    expect(captured!.method).toBe("POST");
    expect(captured!.ct).toBe("application/json");
    expect(JSON.parse(captured!.body)).toEqual({
      executor: "claude_code",
      status: "running",
    } as never);
  });
});
