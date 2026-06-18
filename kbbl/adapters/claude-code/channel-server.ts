#!/usr/bin/env bun
/**
 * kbbl channel MCP server — stdio transport.
 *
 * Productized from /tmp/chanspike/channel-server.ts (spike-verified against
 * CC 2.1.181). This process is spawned as a child of Claude Code via
 * --mcp-config / --dangerously-load-development-channels; it must NOT import
 * anything from the rest of kbbl (the server process is not the parent here).
 *
 * Protocol:
 *   - Read: newline-delimited JSON-RPC on stdin.
 *   - Write: newline-delimited JSON-RPC on stdout.
 *   - On `initialize` → respond with both experimental channel capabilities.
 *   - On `notifications/initialized` → mark ready; flush any queued outbox
 *     lines, then tail for new ones.
 *   - tools/list → { tools: [] }. ping / any id → {}. Never wedge the client.
 *
 * Environment:
 *   KBBL_CHANNEL_OUTBOX — absolute path to the per-session outbox JSONL.
 *   KBBL_CHANNEL_NAME   — name used in log lines (default: kbbl-channel).
 */

import { openSync, readSync, closeSync } from "node:fs";

const OUTBOX_PATH = process.env.KBBL_CHANNEL_OUTBOX ?? "";
const CHANNEL_NAME = process.env.KBBL_CHANNEL_NAME ?? "kbbl-channel";

// ── logging ────────────────────────────────────────────────────────────────

function logline(s: string): void {
  try {
    process.stderr.write(`[${CHANNEL_NAME}] ${s}\n`);
  } catch {
    // stderr may be closed; best-effort
  }
}

// ── JSON-RPC output ────────────────────────────────────────────────────────

function send(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  process.stdout.write(line);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function pushChannel(content: string, meta?: Record<string, string>): void {
  const params: Record<string, unknown> = { content };
  if (meta !== undefined) params.meta = meta;
  send({ jsonrpc: "2.0", method: "notifications/claude/channel", params });
}

// ── outbox tail ─────────────────────────────────────────────────────────────

let byteOffset = 0;
let initialized = false;
/** Lines received before `initialized` — flushed once ready. */
const pendingPushes: Array<{ content: string; meta?: Record<string, string> }> = [];

/**
 * Parse one outbox line.
 * Expected shape: `{ "content": string, "meta"?: Record<string,string> }`
 */
function parseOutboxLine(raw: string): { content: string; meta?: Record<string, string> } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    logline(`outbox: skipping unparseable line: ${trimmed}`);
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).content !== "string"
  ) {
    logline(`outbox: skipping line missing .content: ${trimmed}`);
    return null;
  }
  const p = parsed as Record<string, unknown>;
  const meta = typeof p.meta === "object" && p.meta !== null ? (p.meta as Record<string, string>) : undefined;
  return { content: p.content as string, meta };
}

/**
 * Read any new bytes from the outbox file since `byteOffset`.
 * Returns complete lines found; updates `byteOffset` accordingly.
 */
function drainOutbox(): string[] {
  if (!OUTBOX_PATH) return [];
  let fd: number;
  try {
    fd = openSync(OUTBOX_PATH, "r");
  } catch {
    // File may not exist yet or may be transiently unavailable — next poll retry.
    return [];
  }
  const chunks: Buffer[] = [];
  const BUF_SIZE = 4096;
  let pos = byteOffset;
  for (;;) {
    const buf = Buffer.allocUnsafe(BUF_SIZE);
    let n: number;
    try {
      n = readSync(fd, buf, 0, BUF_SIZE, pos);
    } catch {
      break;
    }
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
    pos += n;
  }
  try {
    closeSync(fd);
  } catch {
    // ignore
  }

  if (chunks.length === 0) return [];
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split("\n");
  // The last element is either empty (trailing newline) or a partial line
  // (write in progress). Either way, do not advance byteOffset past it.
  const completeLines = lines.slice(0, -1);
  const consumed = completeLines.reduce((acc, l) => acc + l.length + 1 /* \n */, 0);
  byteOffset += consumed;
  return completeLines;
}

/** Flush any pending outbox lines as channel pushes (called once initialized). */
function flushPending(): void {
  for (const push of pendingPushes) {
    pushChannel(push.content, push.meta);
  }
  pendingPushes.length = 0;
}

/** Process new outbox lines: buffer if not yet initialized, push otherwise. */
function processOutboxLines(lines: string[]): void {
  for (const raw of lines) {
    const item = parseOutboxLine(raw);
    if (!item) continue;
    if (!initialized) {
      pendingPushes.push(item);
    } else {
      pushChannel(item.content, item.meta);
    }
  }
}

/** Tail the outbox file. Polls at 200ms; each iteration is synchronous. */
function startOutboxTail(): void {
  if (!OUTBOX_PATH) {
    logline("KBBL_CHANNEL_OUTBOX not set — no outbox tailing");
    return;
  }
  // Drain any lines already in the file before we start polling.
  const existing = drainOutbox();
  processOutboxLines(existing);

  setInterval(() => {
    const lines = drainOutbox();
    if (lines.length > 0) processOutboxLines(lines);
  }, 200).unref();
}

// ── stdin JSON-RPC reader ──────────────────────────────────────────────────

let inputBuf = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuf += chunk;
  let idx: number;
  while ((idx = inputBuf.indexOf("\n")) >= 0) {
    const line = inputBuf.slice(0, idx).trim();
    inputBuf = inputBuf.slice(idx + 1);
    if (!line) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    handle(msg);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// ── message dispatch ───────────────────────────────────────────────────────

function handle(msg: Record<string, unknown>): void {
  const { id, method } = msg;

  // Notifications (no `id`): react to `initialized`, ignore everything else.
  if (id === undefined) {
    if (method === "notifications/initialized") {
      const pendingCount = pendingPushes.length;
      logline("notifications/initialized received — marking ready");
      initialized = true;
      flushPending();
      logline(`flushed ${pendingCount} pending pushes`);
    }
    return;
  }

  // Requests (have `id`).
  if (method === "initialize") {
    const params = msg.params as Record<string, unknown> | undefined;
    const protocolVersion =
      typeof params?.protocolVersion === "string"
        ? params.protocolVersion
        : "2025-06-18";
    reply(id, {
      protocolVersion,
      serverInfo: { name: CHANNEL_NAME, version: "1.0.0" },
      capabilities: {
        experimental: {
          // Both keys required — CC's registration filter gates on both
          // `!== undefined`; omitting either silently drops the handler.
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
    });
    // Start the outbox tail now — we'll have outbox lines to deliver once
    // `initialized` arrives.
    startOutboxTail();
    return;
  }

  if (method === "tools/list") {
    reply(id, { tools: [] });
    return;
  }

  if (method === "ping") {
    reply(id, {});
    return;
  }

  // Any other request with an id: empty result so we never wedge the client.
  reply(id, {});
}

logline(`boot — outbox=${OUTBOX_PATH || "(unset)"}`);
