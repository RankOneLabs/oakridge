import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CodexAppServerClient, type CodexNotification, type CodexServerRequest } from "./client";
import type { CodexTransport } from "./transport";

// === Fake transport helpers ===

function makeFakeTransport(): {
  transport: CodexTransport;
  inject: (line: string) => void;
  sent: string[];
} {
  const lineQueue: string[] = [];
  const sent: string[] = [];
  let lineWaiter: (() => void) | null = null;
  let _closed = false;
  const closeHandlers: Array<() => void> = [];

  function inject(line: string): void {
    lineQueue.push(line);
    lineWaiter?.();
    lineWaiter = null;
  }

  const transport: CodexTransport = {
    async writeLine(line: string): Promise<void> {
      sent.push(line);
    },
    async *lines(): AsyncIterable<string> {
      while (true) {
        while (lineQueue.length > 0) {
          yield lineQueue.shift()!;
        }
        if (_closed) return;
        await new Promise<void>((r) => { lineWaiter = r; });
      }
    },
    async close(): Promise<void> {
      _closed = true;
      lineWaiter?.();
      lineWaiter = null;
      for (const h of closeHandlers) {
        try { h(); } catch { /* ignore */ }
      }
    },
    get closed() { return _closed; },
    onClose(handler: () => void) { closeHandlers.push(handler); },
  };

  return { transport, inject, sent };
}

// === Tests ===

describe("request/response correlation", () => {
  test("resolves with matched response", async () => {
    const { transport, inject, sent } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    // Start request
    const promise = client.request<{ pong: boolean }>("ping", {});

    // Wait for the request to be sent
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    const req = JSON.parse(sent[0]) as { id: string; method: string };
    expect(req.method).toBe("ping");

    // Inject a matching response (no jsonrpc field — probe finding #1)
    inject(JSON.stringify({ id: req.id, result: { pong: true } }));

    const result = await promise;
    expect(result.pong).toBe(true);
  });

  test("rejects on error response", async () => {
    const { transport, inject, sent } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    const promise = client.request<unknown>("badMethod", {});

    await new Promise((r) => setTimeout(r, 10));
    const req = JSON.parse(sent[0]) as { id: string };
    inject(JSON.stringify({ id: req.id, error: { code: -32601, message: "Method not found" } }));

    await expect(promise).rejects.toThrow("Method not found");
  });
});

describe("notification fanout by thread id", () => {
  test("routes notifications to correct thread handlers", async () => {
    const { transport, inject } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    const thread1Events: CodexNotification[] = [];
    const thread2Events: CodexNotification[] = [];

    client.subscribeThread("thread-1", (n) => thread1Events.push(n));
    client.subscribeThread("thread-2", (n) => thread2Events.push(n));

    inject(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: "hello" } }));
    inject(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-2", delta: "world" } }));
    inject(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: {} } }));

    await new Promise((r) => setTimeout(r, 20));

    expect(thread1Events).toHaveLength(2);
    expect(thread2Events).toHaveLength(1);
    expect(thread1Events[0].method).toBe("item/agentMessage/delta");
    expect(thread2Events[0].method).toBe("item/agentMessage/delta");
  });

  test("unsubscribe stops delivery", async () => {
    const { transport, inject } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    const events: CodexNotification[] = [];
    const unsub = client.subscribeThread("thread-x", (n) => events.push(n));

    inject(JSON.stringify({ method: "turn/started", params: { threadId: "thread-x", turn: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);

    unsub();

    inject(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-x", turn: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    // Should still be 1 — unsubscribed
    expect(events).toHaveLength(1);
  });
});

describe("server-request routing by thread id", () => {
  test("routes server request to thread handler", async () => {
    const { transport, inject, sent } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    const serverRequests: CodexServerRequest[] = [];
    client.setServerRequestHandler("thread-a", async (req) => {
      serverRequests.push(req);
      await client.sendServerResponse(req.id, { decision: "accept" });
    });

    // Server-initiated request has id field (integer)
    inject(JSON.stringify({ id: 0, method: "item/fileChange/requestApproval", params: { threadId: "thread-a", itemId: "x" } }));

    await new Promise((r) => setTimeout(r, 20));

    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0].method).toBe("item/fileChange/requestApproval");
    expect(serverRequests[0].id).toBe(0);

    // Verify response was sent
    const resp = JSON.parse(sent[sent.length - 1]) as { id: number; result: unknown };
    expect(resp.id).toBe(0);
    expect((resp.result as { decision: string }).decision).toBe("accept");
  });

  test("sends cancel when no handler found", async () => {
    const { transport, inject, sent } = makeFakeTransport();
    new CodexAppServerClient(transport);

    inject(JSON.stringify({ id: 42, method: "item/fileChange/requestApproval", params: { threadId: "unknown-thread" } }));

    await new Promise((r) => setTimeout(r, 20));

    const resp = JSON.parse(sent[sent.length - 1]) as { id: number; result: unknown };
    expect(resp.id).toBe(42);
    expect((resp.result as { decision: string }).decision).toBe("cancel");
  });
});

describe("connection close propagation", () => {
  test("pending requests reject on transport close", async () => {
    const { transport, sent } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    const promise = client.request<unknown>("ping", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);

    // Close the transport
    await transport.close();

    await expect(promise).rejects.toThrow("transport closed");
  });
});

describe("setServerRequestHandler clear", () => {
  test("clearing handler sends cancel", async () => {
    const { transport, inject, sent } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    // Set then clear handler
    client.setServerRequestHandler("thread-b", async (_req) => {});
    client.setServerRequestHandler("thread-b", null);

    inject(JSON.stringify({ id: 5, method: "item/commandExecution/requestApproval", params: { threadId: "thread-b" } }));
    await new Promise((r) => setTimeout(r, 20));

    // No handler registered, so cancel should be sent
    const resp = JSON.parse(sent[sent.length - 1]) as { id: number; result: unknown };
    expect(resp.id).toBe(5);
    expect((resp.result as { decision: string }).decision).toBe("cancel");
  });
});

describe("replay basic-turn fixture", () => {
  test("parses inbound lines from fixture without jsonrpc field requirement", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "basic-turn.jsonl");
    const lines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Verify inbound (dir:"in") messages don't have jsonrpc field
    const inbound = lines.filter((l) => l.dir === "in");
    expect(inbound.length).toBeGreaterThan(0);

    const withJsonrpc = inbound.filter((l) => "jsonrpc" in l);
    expect(withJsonrpc).toHaveLength(0); // confirm probe finding #1

    // Verify response lines have result
    const responses = inbound.filter((l) => "result" in l);
    expect(responses.length).toBeGreaterThan(0);

    // Verify notification lines have method but no id
    const notifications = inbound.filter((l) => "method" in l && !("id" in l));
    expect(notifications.length).toBeGreaterThan(0);
  });

  test("injects inbound lines through fake transport and client dispatches", async () => {
    const { transport, inject } = makeFakeTransport();
    const client = new CodexAppServerClient(transport);

    const fixturePath = join(import.meta.dir, "fixtures", "basic-turn.jsonl");
    const allLines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((l) => l.trim());

    const inboundLines = allLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.dir === "in")
      .map((l) => {
        const { dir: _dir, ...rest } = l;
        return JSON.stringify(rest);
      });

    const threadId = "019e5d59-ab67-7a60-9778-27600d80f3df";
    const notifs: CodexNotification[] = [];
    client.subscribeThread(threadId, (n) => notifs.push(n));

    for (const line of inboundLines) {
      inject(line);
    }
    await new Promise((r) => setTimeout(r, 30));

    const deltaNotifs = notifs.filter((n) => n.method === "item/agentMessage/delta");
    expect(deltaNotifs.length).toBeGreaterThan(0);
  });
});

describe("replay approval-command fixture", () => {
  test("parses approval server-requests with integer ids", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "approval-command.jsonl");
    const lines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const approvalRequests = lines.filter(
      (l) => l.dir === "in" && "id" in l && "method" in l
    );
    expect(approvalRequests.length).toBeGreaterThan(0);

    for (const req of approvalRequests) {
      expect(typeof req.id === "number" || typeof req.id === "string").toBe(true);
      // Verify integer ids (probe finding: Codex uses integer IDs for server requests)
      if (typeof req.id === "number") {
        expect(Number.isInteger(req.id)).toBe(true);
      }
    }
  });

  test("only v2 approval methods present", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "approval-command.jsonl");
    const lines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const serverRequests = lines.filter(
      (l) => l.dir === "in" && "id" in l && "method" in l
    );
    const methods = serverRequests.map((r) => r.method as string);
    for (const method of methods) {
      expect(["item/fileChange/requestApproval", "item/commandExecution/requestApproval"]).toContain(method);
    }
  });
});

describe("replay fork-different-cwd fixture", () => {
  test("fork response contains child thread with new cwd", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "fork-different-cwd.jsonl");
    const lines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Find the fork response
    const forkResponse = lines.find(
      (l) => l.dir === "in" && "result" in l &&
        (l.result as Record<string, unknown>)?.thread !== undefined &&
        ((l.result as Record<string, unknown>).thread as Record<string, unknown>)?.forkedFromId !== null
    );
    expect(forkResponse).toBeDefined();

    const result = forkResponse!.result as Record<string, unknown>;
    const thread = result.thread as Record<string, unknown>;
    expect(thread.cwd).toBe("/home/steve");
    expect(thread.forkedFromId).not.toBeNull();

    // Verify the fork response directly gives us the thread id (probe finding #3:
    // no need to wait for thread/started after fork)
    expect(typeof thread.id).toBe("string");
  });

  test("no thread/started emitted after fork (use fork response thread.id directly)", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "fork-different-cwd.jsonl");
    const lines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Find the fork request id
    const forkReq = lines.find(
      (l) => l.dir === "out" && l.method === "thread/fork"
    );
    expect(forkReq).toBeDefined();

    // Find the fork response
    const forkResp = lines.find((l) => l.dir === "in" && l.id === forkReq!.id);
    expect(forkResp).toBeDefined();

    // Check no thread/started came AFTER the fork response
    const forkRespIdx = lines.indexOf(forkResp!);
    const afterFork = lines.slice(forkRespIdx + 1);
    const forkChildId = ((forkResp!.result as Record<string, unknown>).thread as Record<string, unknown>).id as string;

    const threadStartedForChild = afterFork.find(
      (l) =>
        l.dir === "in" &&
        l.method === "thread/started" &&
        ((l.params as Record<string, unknown>)?.thread as Record<string, unknown>)?.id === forkChildId
    );
    // Probe finding #3: thread/fork does NOT emit thread/started for child
    expect(threadStartedForChild).toBeUndefined();
  });
});
