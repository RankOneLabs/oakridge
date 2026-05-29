// Manages the lifecycle of the Codex app-server process and its client connection.

import { unlink, access } from "node:fs/promises";
import { connect } from "node:net";

import { CodexAppServerClient } from "./protocol/client";
import {
  createStdioTransport,
  createUnixSocketTransport,
  createWsTransport,
} from "./protocol/transport";
import { normalizeModelList, type CodexModel } from "./models";

export interface CodexAppServerOpts {
  /** Path to the codex binary. Defaults to "codex". */
  bin?: string;
  /** Connection URL: "stdio://", "unix://<path>", or "ws://<addr>". */
  listenUrl: string;
  /** Milliseconds to wait for app-server startup. Default: 30000. */
  startupTimeoutMs?: number;
}

export interface CodexAppServerHandle {
  client: CodexAppServerClient;
  models: CodexModel[];
  stop(): Promise<void>;
}

type ParsedUrl =
  | { kind: "stdio" }
  | { kind: "unix"; path: string }
  | { kind: "ws"; url: string };

function parseListenUrl(url: string): ParsedUrl {
  if (url === "stdio://") return { kind: "stdio" };
  if (url.startsWith("unix://")) return { kind: "unix", path: url.slice(7) };
  if (url.startsWith("ws://") || url.startsWith("wss://"))
    return { kind: "ws", url };
  throw new Error(`CodexAppServer: unsupported listenUrl: ${url}`);
}

/**
 * Check if a unix socket path is connectable (i.e., a live server is listening).
 * Returns true if connectable, false if the socket file exists but is stale.
 */
async function isSocketConnectable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
    // Short timeout to avoid hanging
    sock.setTimeout(500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for a unix socket file to appear (for up to timeoutMs).
 */
async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(
    `CodexAppServer: timed out waiting for socket at ${socketPath} (${timeoutMs}ms)`,
  );
}

/**
 * Start (or connect to) a Codex app-server instance.
 *
 * For stdio://:
 *   Spawns codex with --listen stdio:// and connects immediately.
 *
 * For unix://<path>:
 *   - If the socket exists AND is connectable: throws (another instance is running).
 *   - If the socket exists but is NOT connectable: deletes stale socket, spawns codex.
 *   - If the socket doesn't exist: spawns codex, waits for socket to appear.
 *
 * For ws://:
 *   Spawns codex with --listen <url>, then connects via WebSocket.
 */
export async function startCodexAppServer(
  opts: CodexAppServerOpts,
): Promise<CodexAppServerHandle> {
  const bin = opts.bin ?? "codex";
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
  const parsed = parseListenUrl(opts.listenUrl);

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stdioTransport: ReturnType<typeof createStdioTransport> | null = null;

  // Spawn the process
  async function spawnProcess(): Promise<void> {
    const cmd = [bin, "app-server", "--listen", opts.listenUrl];
    proc = Bun.spawn({
      cmd,
      stdin: "pipe",
      stdout: parsed.kind === "stdio" ? "pipe" : "ignore",
      stderr: "ignore",
    });
  }

  // Build the client based on connection type
  let client: CodexAppServerClient;

  if (parsed.kind === "stdio") {
    // Stdio: transport owns the process; capture ref so stop() can kill it
    const transport = createStdioTransport({
      bin,
      args: ["app-server", "--listen", "stdio://"],
    });
    stdioTransport = transport;
    client = new CodexAppServerClient(transport);
  } else if (parsed.kind === "unix") {
    const socketPath = parsed.path;

    // Check if socket already exists
    let socketExists = false;
    try {
      await access(socketPath);
      socketExists = true;
    } catch {
      socketExists = false;
    }

    if (socketExists) {
      const connectable = await isSocketConnectable(socketPath);
      if (connectable) {
        throw new Error(
          `CodexAppServer: socket at ${socketPath} is already connectable — another instance is running`,
        );
      }
      // Stale socket: delete and continue
      await unlink(socketPath);
    }

    // Spawn the app-server
    await spawnProcess();

    // Wait for socket to appear
    await waitForSocket(socketPath, startupTimeoutMs);

    const transport = createUnixSocketTransport({ path: socketPath });
    client = new CodexAppServerClient(transport);
  } else {
    // WebSocket
    await spawnProcess();
    // Brief delay for the ws server to bind
    await new Promise((r) => setTimeout(r, 500));
    const transport = createWsTransport({ url: parsed.url });
    client = new CodexAppServerClient(transport);
  }

  async function stop(): Promise<void> {
    if (stdioTransport) {
      try { await stdioTransport.close(); } catch { /* already dead */ }
    }
    if (proc) {
      try {
        proc.kill();
        await proc.exited;
      } catch {
        // already dead
      }
    }
  }

  let models: CodexModel[] = normalizeModelList(null);
  try {
    // Send initialize (with startup timeout)
    await Promise.race([
      client.initialize({
        clientInfo: { name: "kbbl", title: "kbbl Codex Adapter", version: "0.0.1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`CodexAppServer: initialize timed out after ${startupTimeoutMs}ms`)),
          startupTimeoutMs,
        ),
      ),
    ]);

    // Fetch model list (best-effort — non-fatal)
    try {
      const raw = await client.request<unknown>("model/list", {});
      models = normalizeModelList(raw);
    } catch {
      // Non-fatal: keep pinned Codex models available in the session form.
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return { client, models, stop };
}
