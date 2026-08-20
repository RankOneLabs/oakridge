/**
 * Unit tests for the kbbl channel MCP server (channel-server.ts).
 *
 * Strategy: spawn the server as a subprocess with a temp outbox file, drive it
 * via JSON-RPC on stdin, and assert what it writes on stdout. We avoid importing
 * the server module directly because it mounts handlers on process.stdin, which
 * would conflict with the test process's own stdin.
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// fileURLToPath (not .pathname) so a repo path with spaces / non-ASCII isn't
// percent-encoded and break the subprocess spawn — matches the adapter runtime.
const CHANNEL_SERVER = fileURLToPath(
  new URL("./channel-server.ts", import.meta.url),
);

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  result?: unknown;
  params?: unknown;
}

/** Launch the channel server subprocess and return helpers. */
function launchServer(
  outboxPath: string,
  extraEnv: Record<string, string> = {},
): {
  send: (msg: JsonRpcMsg) => void;
  lines: () => Promise<JsonRpcMsg[]>;
  kill: () => void;
  collectFor: (ms: number) => Promise<JsonRpcMsg[]>;
} {
  const proc = spawn(
    process.execPath, // bun
    [CHANNEL_SERVER],
    {
      env: {
        ...process.env,
        KBBL_CHANNEL_OUTBOX: outboxPath,
        KBBL_CHANNEL_NAME: "test-channel",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const received: JsonRpcMsg[] = [];
  let stdoutBuf = "";
  let waiter: (() => void) | null = null;

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        received.push(JSON.parse(line) as JsonRpcMsg);
        waiter?.();
        waiter = null;
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  function send(msg: JsonRpcMsg): void {
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function lines(): Promise<JsonRpcMsg[]> {
    return Promise.resolve([...received]);
  }

  /**
   * Wait up to `ms` milliseconds, collecting all messages received in that
   * window. Resolves with whatever arrived.
   */
  function collectFor(ms: number): Promise<JsonRpcMsg[]> {
    const before = received.length;
    return new Promise((resolve) => {
      let resolved = false;
      const t = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve([...received].slice(before));
        }
      }, ms);
      // Also resolve early if a new message arrives.
      const origWaiter = waiter;
      waiter = () => {
        origWaiter?.();
        if (!resolved) {
          resolved = true;
          clearTimeout(t);
          // Give 50ms for any additional messages in the same batch.
          setTimeout(() => resolve([...received].slice(before)), 50);
        }
      };
    });
  }

  function kill(): void {
    try { proc.kill(); } catch { /* already dead */ }
  }

  return { send, lines, kill, collectFor };
}

/** Send `initialize` and wait for the response. */
async function handshake(
  srv: ReturnType<typeof launchServer>,
): Promise<JsonRpcMsg> {
  srv.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "test" } },
  });
  // Poll until we see the response.
  for (let i = 0; i < 50; i++) {
    await new Promise<void>((r) => setTimeout(r, 20));
    const msgs = await srv.lines();
    const resp = msgs.find((m) => m.id === 1);
    if (resp) return resp;
  }
  throw new Error("initialize response never arrived");
}

// ── tests ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let outboxPath: string;
let srv: ReturnType<typeof launchServer>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "chan-srv-test-"));
  outboxPath = join(tmpDir, "outbox.jsonl");
  writeFileSync(outboxPath, "");
});

afterEach(() => {
  srv?.kill();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("channel-server initialize", () => {
  test("initialize response declares both experimental channel capabilities", async () => {
    srv = launchServer(outboxPath);
    const resp = await handshake(srv);

    expect(resp.result).toBeDefined();
    const result = resp.result as {
      capabilities?: { experimental?: Record<string, unknown> };
    };
    expect(result.capabilities?.experimental?.["claude/channel"]).toBeDefined();
    expect(result.capabilities?.experimental?.["claude/channel/permission"]).toBeDefined();
  });

  test("initialize echoes protocolVersion from request", async () => {
    srv = launchServer(outboxPath);
    const resp = await handshake(srv);
    const result = resp.result as { protocolVersion?: string };
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/list returns empty tools array", async () => {
    srv = launchServer(outboxPath);
    await handshake(srv);
    srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      const msgs = await srv.lines();
      const resp = msgs.find((m) => m.id === 2);
      if (resp) {
        expect((resp.result as { tools?: unknown[] })?.tools).toEqual([]);
        return;
      }
    }
    throw new Error("tools/list response never arrived");
  });

  test("ping returns empty result", async () => {
    srv = launchServer(outboxPath);
    await handshake(srv);
    srv.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      const msgs = await srv.lines();
      const resp = msgs.find((m) => m.id === 3);
      if (resp) {
        expect(resp.result).toEqual({});
        return;
      }
    }
    throw new Error("ping response never arrived");
  });

  test("unknown request with id returns empty result (never wedges client)", async () => {
    srv = launchServer(outboxPath);
    await handshake(srv);
    srv.send({ jsonrpc: "2.0", id: 99, method: "resources/list" });
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      const msgs = await srv.lines();
      const resp = msgs.find((m) => m.id === 99);
      if (resp) {
        expect(resp.result).toBeDefined();
        return;
      }
    }
    throw new Error("fallback response never arrived");
  });
});

describe("channel-server outbox tailing (after initialized)", () => {
  test("line written after initialized is pushed as notifications/claude/channel", async () => {
    srv = launchServer(outboxPath);
    await handshake(srv);

    // Notify server it is initialized.
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // Give the server a moment to process the notification.
    await new Promise<void>((r) => setTimeout(r, 100));

    // Write a line to the outbox.
    const entry = JSON.stringify({ content: "hello from kbbl", meta: { source: "kbbl" } });
    appendFileSync(outboxPath, entry + "\n");

    // Wait for the channel push (poll interval is 200ms).
    let channelMsg: JsonRpcMsg | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
      const msgs = await srv.lines();
      channelMsg = msgs.find(
        (m) => m.method === "notifications/claude/channel",
      );
      if (channelMsg) break;
    }

    expect(channelMsg).toBeDefined();
    expect(channelMsg!.id).toBeUndefined(); // it's a notification, no id
    const params = channelMsg!.params as { content?: string; meta?: Record<string, string> };
    expect(params.content).toBe("hello from kbbl");
    expect(params.meta?.source).toBe("kbbl");
  });

  test("line written BEFORE initialized is buffered and emitted only after initialized", async () => {
    srv = launchServer(outboxPath);
    await handshake(srv);

    // Write to the outbox BEFORE sending notifications/initialized.
    const entry = JSON.stringify({ content: "buffered message", meta: { source: "kbbl" } });
    appendFileSync(outboxPath, entry + "\n");

    // Wait a bit to confirm it is not pushed yet.
    await new Promise<void>((r) => setTimeout(r, 400));
    const msgsBeforeInit = await srv.lines();
    const premature = msgsBeforeInit.find(
      (m) => m.method === "notifications/claude/channel",
    );
    // Must NOT have pushed yet.
    expect(premature).toBeUndefined();

    // Now send initialized.
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // The buffered push should arrive shortly.
    let channelMsg: JsonRpcMsg | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
      const msgs = await srv.lines();
      channelMsg = msgs.find(
        (m) => m.method === "notifications/claude/channel",
      );
      if (channelMsg) break;
    }

    expect(channelMsg).toBeDefined();
    const params = channelMsg!.params as { content?: string };
    expect(params.content).toBe("buffered message");
  });

  test("multiple outbox lines produce one push each in order", async () => {
    srv = launchServer(outboxPath);
    await handshake(srv);
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise<void>((r) => setTimeout(r, 150));

    appendFileSync(outboxPath, JSON.stringify({ content: "first" }) + "\n");
    appendFileSync(outboxPath, JSON.stringify({ content: "second" }) + "\n");

    const pushes: string[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
      const msgs = await srv.lines();
      const found = msgs.filter((m) => m.method === "notifications/claude/channel");
      pushes.splice(0, pushes.length, ...found.map(
        (m) => (m.params as { content?: string }).content ?? "",
      ));
      if (pushes.length >= 2) break;
    }

    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toBe("first");
    expect(pushes[1]).toBe("second");
  });
});

describe("channel-server delivery", () => {
  /**
   * Sending a push is not delivering it. Claude Code registers its channel
   * notification handler after `notifications/initialized`, from its UI layer,
   * once every configured MCP server has connected. A push that arrives in that
   * window matches no handler and is dropped with no reply and no error — the
   * agent then sits idle forever holding a prompt it never saw.
   *
   * Delivery is therefore confirmed out of band, from the status file the
   * client keeps: any change to it after a push proves the push was seen.
   */
  const CLIENT_STATE = "client-state.json";

  /** Write the client's status file as it looks before it has reacted at all. */
  function writeClientState(dir: string, statusUpdatedAt: number): string {
    const path = join(dir, CLIENT_STATE);
    writeFileSync(path, JSON.stringify({ status: "idle", statusUpdatedAt }));
    return path;
  }

  function pushesIn(msgs: JsonRpcMsg[]): string[] {
    return msgs
      .filter((m) => m.method === "notifications/claude/channel")
      .map((m) => (m.params as { content?: string }).content ?? "");
  }

  test("a push the client never reacts to is re-sent", async () => {
    // Status frozen at launch: the client is up but has reacted to nothing.
    const statePath = writeClientState(tmpDir, Date.now() - 60_000);
    srv = launchServer(outboxPath, {
      KBBL_CHANNEL_CLIENT_STATE: statePath,
      KBBL_CHANNEL_RETRY_MS: "250",
    });
    await handshake(srv);
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise<void>((r) => setTimeout(r, 150));

    appendFileSync(outboxPath, JSON.stringify({ content: "the prompt" }) + "\n");
    await new Promise<void>((r) => setTimeout(r, 1_200));

    const pushes = pushesIn(await srv.lines());
    // Re-sent because nothing ever indicated it landed. Before this behaviour
    // existed the prompt was sent once into a handler that did not yet exist,
    // and the run stalled with no error anywhere.
    expect(pushes.length).toBeGreaterThan(1);
    expect(new Set(pushes)).toEqual(new Set(["the prompt"]));
  });

  test("a push the client reacts to is not re-sent", async () => {
    const statePath = writeClientState(tmpDir, Date.now() - 60_000);
    srv = launchServer(outboxPath, {
      KBBL_CHANNEL_CLIENT_STATE: statePath,
      KBBL_CHANNEL_RETRY_MS: "250",
    });
    await handshake(srv);
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise<void>((r) => setTimeout(r, 150));

    appendFileSync(outboxPath, JSON.stringify({ content: "the prompt" }) + "\n");
    // The client picks it up and starts a turn, which moves its status.
    await new Promise<void>((r) => setTimeout(r, 100));
    writeFileSync(statePath, JSON.stringify({ status: "busy", statusUpdatedAt: Date.now() }));

    await new Promise<void>((r) => setTimeout(r, 1_200));

    expect(pushesIn(await srv.lines())).toEqual(["the prompt"]);
  });
});
