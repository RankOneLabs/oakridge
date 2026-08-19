#!/usr/bin/env bun
/**
 * A stand-in for Claude Code, faithful to the contract kbbl spawns against.
 *
 * The point is to keep every real transport in the loop — kbbl's spawn, the
 * per-session MCP config, the channel server, the outbox tail, the JSON-RPC
 * handshake, the emit route — and substitute only the model. A test that fakes
 * the executor adapter proves none of that; a test that spawns real Claude Code
 * costs tokens and minutes on every run. This is the seam in between, and it is
 * the seam that has been silently breaking.
 *
 * What kbbl requires of the process it spawns, and this therefore honours:
 *   - `--version` answers, because the adapter probes it before launching.
 *   - `--mcp-config <path>` names the per-session MCP set. The `kbbl-channel`
 *     stdio server in it is how the initial prompt arrives; nothing is passed
 *     on argv.
 *   - The channel server pushes only after it sees `notifications/initialized`,
 *     so the handshake must actually complete.
 *   - Exiting is what makes the session terminal, and the exit code is what
 *     oakridge reads as success or failure.
 *
 * The agent's "work" is to do exactly what the rendered prompt tells it to:
 * find the `PUT <url>` lines the dev-flow templates carry and PUT to them. That
 * is deliberate — it makes the template's own instructions load-bearing, so a
 * route rename or a template edit that desyncs the two fails a test instead of
 * failing a real run three days later.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How the stub should behave, so tests can drive failure paths too. */
type StubMode =
  /** Complete the handshake, emit what the prompt asks for, exit 0. */
  | "emit"
  /** Complete the handshake, receive the prompt, emit nothing, stay alive. */
  | "silent"
  /** Never send `notifications/initialized` — reproduces an undelivered prompt. */
  | "never_initialize";

/**
 * Reported by `--version`. The numeric part clears kbbl's validated-minimum
 * warning; the suffix keeps the string honest about what this actually is.
 */
const STUB_VERSION = "2.1.236-kbbl-test-stub";

/** How a stub is configured, and where it says what happened. */
interface StubConfig {
  readonly mode: StubMode;
  readonly timeout_ms: number;
  readonly body: string;
  readonly log_path: string;
}

const DEFAULT_CONFIG: StubConfig = {
  mode: "emit",
  timeout_ms: 20_000,
  body: '{"summary":"stub agent output"}',
  log_path: "",
};

/**
 * Configuration arrives in a file beside the session's MCP config, not in the
 * environment, for two reasons that both bit this harness.
 *
 * First, `process.env.X = value` assigned at runtime does not reach a
 * `Bun.spawn` child — Bun snapshots the environment — so a fixture that sets a
 * variable after its own process started cannot configure what it spawns.
 * Second, `bun test` runs every file in one process, so an environment variable
 * is global mutable state shared by concurrently running fixtures. A file under
 * the fixture's own directory is isolated by construction.
 */
const readConfig = (configPath: string): StubConfig => {
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<StubConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
};

/**
 * Diagnostics go to a file when one is named, because stderr of an MCP-spawned
 * child is exactly the stream that vanished when the real incident was being
 * diagnosed. A test that cannot say *why* the stub gave up is not much better
 * than the stall it replaces.
 */
let config: StubConfig = DEFAULT_CONFIG;

const log = (message: string): void => {
  const line = `[stub-agent ${new Date().toISOString()}] ${message}\n`;
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
  // kbbl's A.1 invariant refuses to launch a binary that does not self-report
  // as Claude Code — a deliberate guard keeping sessions on subscription auth
  // rather than the metered API path. The right way past it in a test is to
  // satisfy it, not to weaken it, so the string carries the marker the gate
  // looks for while saying plainly that this is a stub. No Anthropic endpoint
  // is contacted on either side of the check, so no billing path is bypassed.
  process.stdout.write(`${STUB_VERSION} (Claude Code)\n`);
  process.exit(0);
}

const flagValue = (name: string): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? (argv[index + 1] ?? null) : null;
};

interface ChannelServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const readChannelServerSpec = (mcpConfigPath: string): ChannelServerSpec => {
  const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const channel = parsed.mcpServers?.["kbbl-channel"];
  if (!channel?.command) throw new Error(`no kbbl-channel stdio server in ${mcpConfigPath}`);
  return { command: channel.command, args: channel.args ?? [], env: channel.env ?? {} };
};

/**
 * Every `PUT <url>` the rendered prompt names, in order.
 *
 * The templates state the emit contract as a literal request line; reading it
 * back out is what ties the prompt text to the route that serves it.
 */
const emitTargetsIn = (prompt: string): readonly string[] =>
  prompt
    .split("\n")
    .map((line) => /^\s*PUT\s+(https?:\/\/\S+)\s*$/.exec(line)?.[1])
    .filter((url): url is string => url !== undefined);

const mcpConfigPath = flagValue("--mcp-config");
if (mcpConfigPath === null) {
  log("no --mcp-config on argv; the prompt could never arrive");
  process.exit(64);
}

// The MCP config kbbl writes lives in the fixture's data directory, so it is
// also where the fixture leaves this stub's instructions. Deriving the path
// from an argument kbbl really passes means no extra plumbing through kbbl.
config = readConfig(join(dirname(mcpConfigPath), "stub-config.json"));

const MODE = config.mode;
const TIMEOUT_MS = config.timeout_ms;
const BODY = config.body;

const spec = readChannelServerSpec(mcpConfigPath);
log(`spawning channel server: ${spec.command} ${spec.args.join(" ")}`);

const channel = Bun.spawn([spec.command, ...spec.args], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env, ...spec.env },
});

const writeRpc = (message: unknown): void => {
  channel.stdin.write(`${JSON.stringify(message)}\n`);
  channel.stdin.flush();
};

/** Resolves with the first prompt pushed over the channel. */
const promptFromChannel = async (): Promise<string> => {
  const decoder = new TextDecoder();
  const reader = (channel.stdout as ReadableStream<Uint8Array>).getReader();
  let buffered = "";
  let handshakeSent = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message: { id?: unknown; method?: unknown; params?: { content?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // The initialize reply is the cue to finish the handshake. Withholding
      // `notifications/initialized` is a supported mode precisely because that
      // is the state a stalled session sits in.
      if (message.id !== undefined && !handshakeSent) {
        handshakeSent = true;
        if (MODE === "never_initialize") {
          log("mode=never_initialize — withholding notifications/initialized");
          continue;
        }
        log("initialize acknowledged — sending notifications/initialized");
        writeRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
        continue;
      }
      if (message.method === "notifications/claude/channel" && typeof message.params?.content === "string") {
        return message.params.content;
      }
    }
  }
  throw new Error("channel server closed before pushing a prompt");
};

const failOnTimeout = new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no prompt arrived within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref: () => void }).unref();
});

log(`sending initialize (mode=${MODE})`);
writeRpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stub-agent", version: "0.0.0" } },
});

let prompt: string;
try {
  prompt = await Promise.race([promptFromChannel(), failOnTimeout]);
} catch (error) {
  // Exiting non-zero is what turns an undelivered prompt into a failed unit
  // instead of a run that waits forever.
  log(`giving up: ${error instanceof Error ? error.message : String(error)}`);
  channel.kill();
  process.exit(70);
}

log(`prompt received (${prompt.length} chars)`);

if (MODE === "silent") {
  log("mode=silent — received the prompt, emitting nothing, staying alive");
  await new Promise(() => {});
}

const targets = emitTargetsIn(prompt);
if (targets.length === 0) {
  log("prompt named no PUT target; the template and the emit contract disagree");
  channel.kill();
  process.exit(71);
}

for (const target of targets) {
  log(`PUT ${target}`);
  const response = await fetch(target, {
    method: "PUT",
    headers: { "content-type": "application/json", "idempotency-key": `stub-agent:${target}` },
    body: BODY,
  });
  if (!response.ok) {
    log(`emit refused (${response.status}): ${await response.text()}`);
    channel.kill();
    process.exit(72);
  }
}

log(`emitted ${targets.length} artifact(s); exiting clean`);
channel.kill();
process.exit(0);
