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
 *   KBBL_CHANNEL_CLIENT_STATE — path to the client's session-state JSON, used
 *     to confirm a push was seen. Defaults to CC's own file for the parent pid.
 *   KBBL_CHANNEL_RETRY_MS — how long an unacknowledged push waits before being
 *     re-sent (default 4000).
 */

import { openSync, readSync, closeSync, appendFileSync, readFileSync } from "node:fs";

const OUTBOX_PATH = process.env.KBBL_CHANNEL_OUTBOX ?? "";
const CHANNEL_NAME = process.env.KBBL_CHANNEL_NAME ?? "kbbl-channel";

// ── logging ────────────────────────────────────────────────────────────────

/**
 * Where diagnostics survive the process.
 *
 * This server's stderr belongs to the CC subprocess that spawned it, and is
 * discarded. That is fine until a session stalls: the prompt sits buffered here
 * and the one record of why is gone the moment the process dies. Writing beside
 * the outbox — the only path this server is guaranteed to know — leaves the
 * evidence where whoever is investigating the session is already looking.
 */
const LOG_PATH = OUTBOX_PATH ? OUTBOX_PATH.replace(/\.jsonl$/, "") + ".log" : null;

function logline(s: string): void {
  const line = `[${CHANNEL_NAME}] ${new Date().toISOString()} ${s}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr may be closed; the file sink below is the durable one.
  }
  if (LOG_PATH === null) return;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // best-effort: a missing directory must not take the transport down
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

// ── protocol revision ───────────────────────────────────────────────────────

/**
 * The first protocol revision with no delivery path for unsolicited
 * notifications.
 *
 * Claude Code classifies a connection by the revision it negotiated: from this
 * date on the connection is "modern", and CC declines to register a handler for
 * any custom notification, logging that the revision "has no delivery path for
 * unsolicited custom notifications". A channel push is exactly such a
 * notification, so a modern connection cannot carry one at all.
 */
const MODERN_ERA_FLOOR = "2026-07-28";

/** The newest revision known to predate that floor. */
const NEWEST_LEGACY_REVISION = "2025-11-25";

/**
 * Which revision to negotiate, given what the client asked for.
 *
 * Echoing the request is what this server used to do, and it is a trap: the
 * revision the client asks for is the one that decides whether this transport
 * works at all, so echoing hands the client the power to silently disable the
 * channel. It is safe today only because CC's `server/discover` probe gets an
 * empty result here, which drops it onto its legacy handshake and makes it ask
 * for a pre-floor revision. Nothing about that is a guarantee.
 *
 * So the answer is clamped rather than echoed. A client asking for a modern
 * revision gets the newest legacy one instead: either it accepts, and the
 * channel keeps working, or it rejects the handshake outright — which is a loud
 * failure at connect time rather than an agent that sits idle forever holding a
 * prompt nobody can deliver.
 */
function deliverableProtocolVersion(requested: string): string {
  if (requested < MODERN_ERA_FLOOR) return requested;
  logline(
    `client asked for protocol revision ${requested}, which is modern-era ` +
    `(>= ${MODERN_ERA_FLOOR}) and carries no unsolicited notifications — ` +
    `answering ${NEWEST_LEGACY_REVISION} so channel pushes stay deliverable`,
  );
  return NEWEST_LEGACY_REVISION;
}

/** One outbox line, as it travels to the client. */
interface ChannelPush {
  readonly content: string;
  readonly meta?: Record<string, string>;
}

function pushChannel(push: ChannelPush): void {
  const params: Record<string, unknown> = { content: push.content };
  if (push.meta !== undefined) params.meta = push.meta;
  send({ jsonrpc: "2.0", method: "notifications/claude/channel", params });
  noteUnacknowledged(push);
}

// ── outbox tail ─────────────────────────────────────────────────────────────

let byteOffset = 0;
let initialized = false;
/** Lines received before `initialized` — flushed once ready. */
const pendingPushes: ChannelPush[] = [];

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
  // byteOffset indexes the file in UTF-8 bytes (drainOutbox reads by byte
  // position), so advance by UTF-8 byte length — l.length would count UTF-16
  // code units and desync the offset on any multibyte content.
  const consumed = completeLines.reduce(
    (acc, l) => acc + Buffer.byteLength(l, "utf8") + 1 /* \n */,
    0,
  );
  byteOffset += consumed;
  return completeLines;
}

/** Flush any pending outbox lines as channel pushes (called once initialized). */
function flushPending(): void {
  for (const push of pendingPushes) {
    pushChannel(push);
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
      pushChannel(item);
    }
  }
}

// ── delivery ────────────────────────────────────────────────────────────────

/**
 * Sending a push is not delivering it.
 *
 * `notifications/initialized` means the client's MCP layer is up. It does not
 * mean the client has registered a handler for `notifications/claude/channel` —
 * Claude Code does that later, from its UI layer, once every configured server
 * has finished connecting. A notification arriving in that window matches no
 * handler and is discarded without a reply, an error, or a log line. The prompt
 * is gone, the agent sits at `idle` forever, and the session reports itself
 * perfectly healthy — a run stalled for three and a half hours exactly this way.
 *
 * There is no acknowledgement in the channel protocol to wait on, so delivery is
 * confirmed from the outside: Claude Code publishes its own liveness, and any
 * change to it after a push is proof the push was seen. Until that proof
 * arrives, the push is re-sent. A dropped notification leaves no trace to
 * detect, so the only safe assumption is that an unanswered push never landed.
 */

/** Pushes sent with no evidence the client reacted. Re-sent until there is. */
let unacknowledged: ChannelPush[] = [];
let sentAt: number | null = null;
let deliveryTimer: ReturnType<typeof setInterval> | null = null;

/** How often to look for a reaction. */
const DELIVERY_POLL_MS = 100;
const DEFAULT_DELIVERY_RETRY_MS = 4_000;

/**
 * How long to wait for one before re-sending.
 *
 * Long enough that a client which did receive the push is already reacting, so
 * a re-send is genuinely evidence of loss rather than impatience.
 *
 * Parsed defensively: `Number("")` is 0 and `Number("soon")` is NaN, and both
 * defeat the throttle — every `x < NaN` is false, so an unparseable override
 * would re-send on every poll tick and burn all eight attempts in under a
 * second. A bad value falls back to the default and says so.
 */
function configuredRetryMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DELIVERY_RETRY_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  logline(
    `KBBL_CHANNEL_RETRY_MS=${JSON.stringify(raw)} is not a positive number — ` +
    `using ${DEFAULT_DELIVERY_RETRY_MS}ms`,
  );
  return DEFAULT_DELIVERY_RETRY_MS;
}

const DELIVERY_RETRY_MS = configuredRetryMs(process.env.KBBL_CHANNEL_RETRY_MS);
/** How many times to re-send before the silence is someone else's problem. */
const DELIVERY_MAX_ATTEMPTS = 8;

/**
 * Where Claude Code publishes this session's status and when it last changed.
 *
 * This server runs as a child of the Claude Code process, so the parent pid
 * names the file. `CLAUDE_CONFIG_DIR` relocates the whole config tree, so it
 * wins over `HOME` when set.
 */
function parentStatePath(): string | null {
  const override = process.env.KBBL_CHANNEL_CLIENT_STATE;
  if (override !== undefined && override !== "") return override;
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ?? (process.env.HOME !== undefined ? `${process.env.HOME}/.claude` : undefined);
  if (configDir === undefined) return null;
  return `${configDir}/sessions/${process.ppid}.json`;
}

/** When the client last changed status, or null if that cannot be read. */
function parentStatusChangedAt(path: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const changedAt = (parsed as Record<string, unknown>).statusUpdatedAt;
    return typeof changedAt === "number" ? changedAt : null;
  } catch {
    // The file appears when the client starts and is rewritten in place; a
    // transient read failure is not evidence of anything.
    return null;
  }
}

function noteUnacknowledged(push: ChannelPush): void {
  unacknowledged.push(push);
  if (deliveryTimer !== null) return;
  sentAt = Date.now();

  const statePath = parentStatePath();
  if (statePath === null) {
    logline(
      "cannot locate the client's session state (no CLAUDE_CONFIG_DIR or HOME) — " +
      "pushes are sent unverified; a dropped one will not be retried",
    );
    // No watch will run, so nothing would ever drain this. Dropping it here
    // keeps an unverifiable session from accumulating every push it ever sent.
    stopDeliveryWatch();
    return;
  }

  let attempts = 1;
  let lastAttemptAt = sentAt;
  deliveryTimer = setInterval(() => {
    const changedAt = parentStatusChangedAt(statePath);
    if (changedAt !== null && sentAt !== null && changedAt > sentAt) {
      logline(`push acknowledged — client reacted after ${attempts} attempt(s)`);
      // A status change proves the client saw *something*, never which push.
      // With more than one in flight the acknowledgement is claimed by all of
      // them, so an earlier push dropped before the handler existed is retired
      // here without ever having landed. Nothing in the protocol can tell the
      // two apart, so say so rather than let it disappear.
      if (unacknowledged.length > 1) {
        logline(
          `WARNING: ${unacknowledged.length} pushes were in flight and one ` +
          `acknowledgement retired all of them — an earlier push may never have ` +
          `been delivered. Contents: ${unacknowledged
            .map((p) => JSON.stringify(p.content.slice(0, 80)))
            .join(", ")}`,
        );
      }
      stopDeliveryWatch();
      return;
    }
    if (Date.now() - lastAttemptAt < DELIVERY_RETRY_MS) return;
    if (attempts >= DELIVERY_MAX_ATTEMPTS) {
      logline(
        `client has not reacted to ${unacknowledged.length} push(es) after ` +
        `${attempts} attempts — giving up. The agent has received nothing.`,
      );
      stopDeliveryWatch();
      return;
    }
    attempts += 1;
    lastAttemptAt = Date.now();
    logline(`no reaction yet — re-sending ${unacknowledged.length} push(es) (attempt ${attempts})`);
    for (const push of unacknowledged) {
      const params: Record<string, unknown> = { content: push.content };
      if (push.meta !== undefined) params.meta = push.meta;
      send({ jsonrpc: "2.0", method: "notifications/claude/channel", params });
    }
  }, DELIVERY_POLL_MS);
  deliveryTimer.unref();
}

function stopDeliveryWatch(): void {
  if (deliveryTimer !== null) clearInterval(deliveryTimer);
  deliveryTimer = null;
  unacknowledged = [];
  sentAt = null;
}

/**
 * How long the client may take to finish the handshake before the wait is
 * called out as the fault it is.
 *
 * Buffering until `notifications/initialized` is correct — a push sent before
 * the client is ready is dropped. What was missing is any acknowledgement that
 * the wait can be unbounded: a client that never initializes leaves the prompt
 * queued here forever while the session reports itself perfectly healthy. That
 * is precisely how a run came to sit untouched for hours.
 *
 * This says so rather than acting on it. Whether the unit dies is oakridge's
 * call — it holds the silence bound, and a transport unilaterally killing a
 * session would be a second owner for that decision.
 */
const HANDSHAKE_DEADLINE_MS = 60_000;

function startHandshakeWatch(): void {
  setTimeout(() => {
    if (initialized) return;
    logline(
      `notifications/initialized has not arrived after ${HANDSHAKE_DEADLINE_MS}ms — ` +
      `${pendingPushes.length} push(es) are buffered and undeliverable. The agent will ` +
      `receive nothing until it completes the MCP handshake.`,
    );
  }, HANDSHAKE_DEADLINE_MS).unref();
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
    const requested =
      typeof params?.protocolVersion === "string"
        ? params.protocolVersion
        : "2025-06-18";
    reply(id, {
      protocolVersion: deliverableProtocolVersion(requested),
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

logline(`boot — outbox=${OUTBOX_PATH || "(unset)"} log=${LOG_PATH || "(unset)"}`);
// Watched from boot rather than from `initialize`: a client that never sends
// even that is the worse case, and the one with nothing else to notice it.
startHandshakeWatch();
