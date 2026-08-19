#!/usr/bin/env bun
/**
 * A stand-in for `codex app-server`, faithful to the contract kbbl connects
 * against.
 *
 * The sibling of `stub-agent.ts`, and deliberately a separate program, because
 * nothing about the Claude Code transport carries over:
 *
 *   | | claude-code | codex |
 *   |-|-------------|-------|
 *   | process | one PTY per session | one shared app-server |
 *   | prompt  | channel MCP push from an outbox file | `turn/start` JSON-RPC |
 *   | done    | process exit + exit code | `turn/completed` notification |
 *
 * A test that covers only one of these proves nothing about the other, and the
 * dev flow can be configured to either per stage — `runtime` is bound from run
 * context, so a single run can mix them.
 *
 * Invoked by kbbl as `<bin> app-server --listen unix://<path>`, then spoken to
 * with newline-delimited JSON-RPC over that socket.
 *
 * As with the CC stub, the "work" is to do exactly what the prompt says: find
 * the `PUT <url>` lines the dev-flow templates carry and PUT to them, so the
 * template's own instructions stay load-bearing.
 */
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

type StubMode =
  /** Run the turn, emit what the prompt asks for, report `turn/completed`. */
  | "emit"
  /** Accept the turn, emit nothing, never report completion. */
  | "silent"
  /** Report the turn as failed without emitting. */
  | "fail";

/** How a stub is configured, and where it says what happened. */
interface StubConfig {
  readonly mode: StubMode;
  readonly body: string;
  readonly log_path: string;
}

const DEFAULT_CONFIG: StubConfig = { mode: "emit", body: '{"summary":"stub codex output"}', log_path: "" };

/**
 * Configuration arrives in a file beside the socket, not in the environment.
 *
 * kbbl starts this process with `Bun.spawn`, and a `process.env.X = value`
 * assigned at runtime by the fixture never reaches such a child — Bun snapshots
 * the environment. (The Claude Code stub is spawned through a PTY, which does
 * pass it, so the two runtimes disagreed and only codex came up unconfigured.)
 * A file also keeps concurrent fixtures isolated, which matters because
 * `bun test` runs every file in one process.
 */
const readConfig = (configPath: string): StubConfig => {
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<StubConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
};

let config: StubConfig = DEFAULT_CONFIG;

const log = (message: string): void => {
  const line = `[stub-codex ${new Date().toISOString()}] ${message}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr may be closed; the file sink below is the durable one.
  }
  if (config.log_path === "") return;
  try {
    appendFileSync(config.log_path, line);
  } catch {
    // best-effort
  }
};

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-kbbl-test-stub\n");
  process.exit(0);
}

const listenIndex = argv.indexOf("--listen");
const listenUrl = listenIndex >= 0 ? argv[listenIndex + 1] : undefined;
if (!argv.includes("app-server") || listenUrl === undefined) {
  log(`unsupported invocation: ${argv.join(" ")}`);
  process.exit(64);
}
if (!listenUrl.startsWith("unix://")) {
  log(`only unix:// sockets are supported by this stub, got ${listenUrl}`);
  process.exit(64);
}
const socketPath = listenUrl.slice("unix://".length);
// The socket sits in the fixture's data directory, which is also where the
// fixture leaves this stub's instructions — no plumbing through kbbl required.
config = readConfig(join(dirname(socketPath), "stub-config.json"));
const MODE = config.mode;
const BODY = config.body;

/** Every `PUT <url>` the rendered prompt names, in order. */
const emitTargetsIn = (prompt: string): readonly string[] =>
  prompt
    .split("\n")
    .map((line) => /^\s*PUT\s+(https?:\/\/\S+)\s*$/.exec(line)?.[1])
    .filter((url): url is string => url !== undefined);

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: Record<string, unknown>;
}

/** Minimal shape of a socket we can write framed JSON-RPC back to. */
interface RpcSink { write(data: string): unknown }

const send = (socket: RpcSink, payload: unknown): void => {
  socket.write(`${JSON.stringify(payload)}\n`);
};
const reply = (socket: RpcSink, id: unknown, result: unknown): void =>
  send(socket, { jsonrpc: "2.0", id, result });
const notify = (socket: RpcSink, method: string, params: unknown): void =>
  send(socket, { jsonrpc: "2.0", method, params });

/** The single model this stub serves, named in `model/list` and thread starts. */
export const STUB_MODEL = "stub-model";

let threadCounter = 0;
let turnCounter = 0;

const thread = (id: string, cwd: string) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  preview: "",
  ephemeral: false,
  modelProvider: "stub",
  cwd,
});

const threadStartResult = (cwd: string) => {
  const id = `stub-thread-${++threadCounter}`;
  return {
    thread: thread(id, cwd),
    model: STUB_MODEL,
    modelProvider: "stub",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "stub",
    sandbox: "workspace-write",
  };
};

/**
 * Runs one turn: do what the prompt says, then report completion.
 *
 * Completion is reported as a notification after the `turn/start` reply, which
 * is the ordering the real app-server uses — the client returns from
 * `turnStart` immediately and learns the outcome from the event stream.
 */
const runTurn = async (socket: RpcSink, threadId: string, turnId: string, prompt: string): Promise<void> => {
  const completed = (status: "completed" | "failed") => {
    notify(socket, "turn/completed", {
      threadId,
      turn: { id: turnId, items: [], itemsView: "", status, error: null, startedAt: Date.now(), completedAt: Date.now(), durationMs: 1 },
    });
  };

  if (MODE === "silent") {
    log("mode=silent — turn accepted, no emit, no completion");
    return;
  }
  if (MODE === "fail") {
    log("mode=fail — reporting the turn as failed without emitting");
    completed("failed");
    return;
  }

  const targets = emitTargetsIn(prompt);
  if (targets.length === 0) {
    log("prompt named no PUT target; the template and the emit contract disagree");
    completed("failed");
    return;
  }
  for (const target of targets) {
    log(`PUT ${target}`);
    const response = await fetch(target, {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": `stub-codex:${target}` },
      body: BODY,
    });
    if (!response.ok) {
      log(`emit refused (${response.status}): ${await response.text()}`);
      completed("failed");
      return;
    }
  }
  log(`emitted ${targets.length} artifact(s); reporting turn complete`);
  completed("completed");
};

const handle = (socket: RpcSink, message: JsonRpcMessage): void => {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications from the client need no answer

  switch (method) {
    case "initialize":
      return reply(socket, id, { userAgent: "stub-codex/0.0.0", codexHome: "/tmp/stub-codex", platformFamily: "unix", platformOs: process.platform });

    // The runtime probes this to decide slash-vs-mention skill invocation.
    // Answering keeps that probe on its supported branch.
    case "skills/list":
      return reply(socket, id, { skills: [] });

    case "mcpServerStatus/list":
      return reply(socket, id, { servers: [] });

    // The runtime builds its allowed-model list from this. Answering with an
    // empty array leaves `isAllowedModel` undefined, so kbbl would reject any
    // model a stage asks for — the stub has to name the one it accepts.
    case "model/list":
      return reply(socket, id, [{ id: STUB_MODEL, label: "Stub model" }]);

    case "thread/start":
    case "thread/fork":
      return reply(socket, id, threadStartResult(typeof params?.cwd === "string" ? params.cwd : process.cwd()));

    case "thread/unsubscribe":
      return reply(socket, id, {});

    case "turn/start": {
      const threadId = typeof params?.threadId === "string" ? params.threadId : "stub-thread-0";
      const turnId = `stub-turn-${++turnCounter}`;
      const input = Array.isArray(params?.input) ? params.input : [];
      const prompt = input
        .map((item) => (typeof item === "object" && item !== null && "text" in item ? String((item as { text: unknown }).text) : ""))
        .join("\n");
      log(`turn/start on ${threadId} (${prompt.length} chars of input)`);
      reply(socket, id, { turn: { id: turnId, items: [], itemsView: "", status: "in_progress", error: null, startedAt: Date.now(), completedAt: null, durationMs: null } });
      void runTurn(socket, threadId, turnId, prompt);
      return;
    }

    case "turn/interrupt":
      return reply(socket, id, {});

    // Never wedge the client on a method this stub has not learned yet.
    default:
      log(`unhandled method '${String(method)}' — replying empty`);
      return reply(socket, id, {});
  }
};

// A stale socket file from a crashed predecessor would make listen() fail.
try {
  unlinkSync(socketPath);
} catch {
  // absent is the normal case
}

const buffers = new WeakMap<object, string>();

Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      buffers.set(socket, "");
      log("client connected");
    },
    data(socket, chunk) {
      let buffered = `${buffers.get(socket) ?? ""}${chunk.toString()}`;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          handle(socket, JSON.parse(line) as JsonRpcMessage);
        } catch (error) {
          log(`unparseable line dropped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      buffers.set(socket, buffered);
    },
    close(socket) {
      buffers.delete(socket);
      log("client disconnected");
    },
  },
});

log(`listening on ${socketPath} (mode=${MODE})`);
