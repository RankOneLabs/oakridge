import type { Hono } from "hono";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import * as pty from "bun-pty";

import type { EnvelopeEvent, Session, SpawnCmd } from "../../core/session/session";
import type { SessionManager } from "../../core/session/session-manager";
import type {
  AgentRuntime,
  AppRuntime,
  ResumeRef,
  RuntimeDescriptor,
  RuntimeEvent,
  RuntimeSnapshotContrib,
  SessionHandle,
  RuntimeConfig,
} from "../../core/runtime";
import { extractResultUsage } from "../../core/session/session";
import { readJsonlOrEmpty } from "../../core/session/session";
import { ALLOWED_MODELS } from "./models";

import { classifyCcEvent } from "./event-classifier";
import {
  hookPermissionHandler,
  hookPostToolUseHandler,
  hookStopHandler,
  hookSessionStartHandler,
  hookSessionEndHandler,
  hookNotificationHandler,
  hookSubagentStartHandler,
  hookSubagentStopHandler,
  type HookHandlerDeps,
  type CcTurnTracker,
} from "./hook-route";
import { projectUsage, type TranscriptAssistantMessage } from "./transcript";
import { ensureTranscriptTailer } from "./transcript-tailer";
import {
  assertA1Invariants,
  buildCcArgv,
  ensureWorkspaceTrusted,
  writeCcMcpConfig,
  writeCcSettings,
} from "./spawn";

// Resolve the readiness gate (see CcHandle.ready) on this fallback even if CC
// produces no PTY output, so send() can never hang on a silent/broken launch.
// Bounds worst-case first-write latency: a launch that emits nothing still
// dispatches the first message within this window rather than waiting forever.
const READY_FALLBACK_MS = 10_000;

/**
 * Block until CC's PTY output has been quiet for `quietMs`, or `maxWaitMs`
 * elapses. `getLastOutputAt()` returns the epoch-ms of the most recent PTY
 * output (kept current by the onData listeners). Returns "quiet" when CC went
 * idle, or "timeout" when the safety cap fired first.
 *
 * `now`/`sleep` are injectable (default `Date.now` / `setTimeout`) so tests can
 * drive a deterministic fake clock instead of asserting against wall-clock.
 * `now()` is read once per loop iteration.
 */
export async function awaitPtyQuiescence(
  getLastOutputAt: () => number,
  opts: {
    quietMs: number;
    maxWaitMs: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<"quiet" | "timeout"> {
  const pollMs = opts.pollMs ?? 50;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.maxWaitMs;
  for (;;) {
    const tick = now();
    const quietFor = tick - getLastOutputAt();
    if (quietFor >= opts.quietMs) return "quiet";
    if (tick >= deadline) return "timeout";
    const wait = Math.min(opts.quietMs - quietFor, pollMs, deadline - tick);
    await sleep(Math.max(wait, 1));
  }
}

/**
 * Derive CC's on-disk transcript path from the session cwd and CC session id.
 * CC stores transcripts at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,
 * where `<encoded-cwd>` is the absolute cwd with every non-alphanumeric
 * character replaced by `-`.
 *
 * Computing this lets the transcript tailer start at launch instead of waiting
 * for a hook to report `transcript_path`: the SessionStart hook is not
 * guaranteed to arrive, and a plain text turn fires no tool/permission hook, so
 * the first reliable hook would otherwise be Stop — i.e. only at the END of the
 * first turn, leaving turn-start detection and the Conversation view blind for
 * the whole turn. The hook-driven `ensureTranscriptTailer` calls remain as
 * idempotent backstops should CC ever change this encoding.
 */
export function ccTranscriptPath(cwd: string, ccSessionId: string): string {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", encoded, `${ccSessionId}.jsonl`);
}

export interface CreateClaudeCodeRuntimeOpts {
  claudeBin: string;
  /** Server's HTTP port — baked into hook URLs in the generated settings.json. */
  port: number;
  /** Directory where the generated settings.json lives. */
  dataDir: string;
}

/** CC-specific session handle backed by a bun-pty process. */
interface CcHandle {
  readonly sessionId: string;
  pty: pty.IPty;
  /**
   * Set by the onExit listener (registered in spawn(), so it fires even if
   * events() is never consumed). Lets events() replay the completion if the
   * PTY exits during the window between spawn() returning and events() being
   * entered.
   */
  exited: { code: number } | null;
  /** Set by an active events() consumer so onExit can wake it. */
  notifyExit: (() => void) | null;
  /**
   * Resolves once CC's PTY has produced its first output (the REPL is up and
   * rendering) — or a fallback timeout / process exit, whichever comes first.
   * Awaited by events() before starting the transcript tailer so the first
   * output (including modal acceptance) is not missed.
   */
  ready: Promise<void>;
  /** Idempotent resolver for `ready` (multiple calls are harmless). */
  markReady: () => void;
  /** Absolute cwd of the CC process — used to derive the transcript path. */
  readonly cwd: string;
  /** CC's session id — the transcript filename stem. */
  readonly ccSessionId: string;
  /**
   * Epoch-ms of the most recent PTY output, kept current by the spawn()-level
   * onData listener (registered at process creation, so it stays live even
   * before events() begins consuming).
   */
  lastOutputAt: number;
  /**
   * Absolute path to the per-session channel outbox file. The channel server
   * tails this file and pushes each line as `notifications/claude/channel`.
   * `send()` appends to it instead of writing PTY bytes.
   */
  readonly channelOutboxPath: string;
  /**
   * Guard for the dev-channels modal acceptance. The `--dangerously-load-
   * development-channels` flag causes CC to show a warning modal on every
   * launch that blocks the REPL. We accept it with a single `\r` on the first
   * PTY output that matches `/development/i`. This boolean ensures we fire
   * at most once per session.
   */
  devChannelsAccepted: boolean;
}

/**
 * The CC RuntimeDescriptor, built from the ALLOWED_MODELS list. Excludes
 * the short-alias entries (opus/sonnet/haiku) so the dropdown only surfaces
 * pinned version ids. The aliases are still accepted for API callers.
 */
const CC_DESCRIPTOR: RuntimeDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  models: ALLOWED_MODELS.filter((m) => m.includes("-")).map((m) => ({
    value: m,
    label: m,
  })),
  supportsCompaction: true,
};

/**
 * Apply a single transcript event to a CcTurnTracker. Pure function; exported
 * so it can be unit-tested independently of the factory closure.
 *
 * - `user` with string content → new operator turn started; reset resultedThisTurn.
 * - `user` with array content → tool_result block, not a turn start; no reset.
 * - `assistant` with usage → update lastAssistantUsage for the synthetic result.
 * - `result` → mark resultedThisTurn = true (a real result was already emitted).
 */
export function updateCcTurnTracker(
  tracker: CcTurnTracker,
  type: string,
  payload: unknown,
): void {
  if (type === "user") {
    // String content = operator message (new turn start).
    // Array content = tool_result block; not a new operator turn.
    const msg = (payload as { message?: { content?: unknown } })?.message;
    if (typeof msg?.content === "string") {
      tracker.resultedThisTurn = false;
      tracker.lastAssistantUsage = null;
    }
  } else if (type === "assistant") {
    const msg = (payload as { message?: { usage?: unknown } })?.message;
    if (msg?.usage !== undefined) {
      tracker.lastAssistantUsage = projectUsage(
        msg.usage as TranscriptAssistantMessage["usage"],
      );
    }
  } else if (type === "result") {
    tracker.resultedThisTurn = true;
  }
}

/**
 * Constructs the Claude Code adapter. The async factory writes the CC
 * settings.json (so the spawn flag `--settings <path>` resolves) and
 * captures the static spawn context. The returned object implements both
 * the AgentRuntime interface (new, full-lifecycle contract) and the legacy
 * AppRuntime interface (backward compat: buildSpawnCmd + mountRoutes).
 */
export async function createClaudeCodeRuntime(
  opts: CreateClaudeCodeRuntimeOpts,
): Promise<AgentRuntime & AppRuntime> {
  const settingsPath = await writeCcSettings({
    dataDir: opts.dataDir,
    port: opts.port,
  });

  // Resolve bun binary and channel-server path once at factory time.
  // The channel-server is co-located in the same adapter directory as this
  // module — resolve relative to import.meta so it works regardless of the
  // working directory the server process was launched from.
  const bunBin = Bun.which("bun");
  if (!bunBin) {
    throw new Error(
      "kbbl-channel: unable to resolve the bun binary (Bun.which returned null) — the channel MCP server cannot be spawned",
    );
  }
  // fileURLToPath (not .pathname) so a repo path with spaces / non-ASCII
  // doesn't arrive percent-encoded and break the spawn.
  const channelServerPath = fileURLToPath(
    new URL("./channel-server.ts", import.meta.url),
  );

  // === CC session id registry ===
  // Maps CC's runtime session_id (from system/init) → oakridgeSid. The
  // CC adapter owns this map; the SessionManager delegates getByCcSid to
  // opts.lookupByCcSid which calls back into this function.
  const ccSidToOakridgeSid = new Map<string, string>();
  const oakridgeSidToSession = new Map<string, Session>();

  function registerCcSid(ccSid: string, oakridgeSid: string): void {
    ccSidToOakridgeSid.set(ccSid, oakridgeSid);
  }

  function unregisterBySid(session: Session): void {
    const ccSid = session.currentCcSid;
    if (ccSid && ccSidToOakridgeSid.get(ccSid) === session.oakridgeSid) {
      ccSidToOakridgeSid.delete(ccSid);
    }
    oakridgeSidToSession.delete(session.oakridgeSid);
    subagentCounts.delete(session.oakridgeSid);
    turnTrackers.delete(session.oakridgeSid);
  }

  function lookupByCcSid(ccSid: string): Session | undefined {
    const oakridgeSid = ccSidToOakridgeSid.get(ccSid);
    return oakridgeSid ? oakridgeSidToSession.get(oakridgeSid) : undefined;
  }

  // === in-flight process map ===
  const procs = new Map<string, CcHandle>();

  // === billing observability (A.7) ===
  // Cumulative SubagentStop count per oakridgeSid for this server lifetime.
  const subagentCounts = new Map<string, number>();

  // === per-session turn/result tracker ===
  // Keyed by oakridgeSid. Maintained by the tailer emit callback (via
  // onTranscriptEvent → updateTurnTracker) and read/written by the Stop handler.
  const turnTrackers = new Map<string, CcTurnTracker>();

  function updateTurnTracker(
    oakridgeSid: string,
    type: string,
    payload: unknown,
  ): void {
    const tracker = turnTrackers.get(oakridgeSid);
    if (!tracker) return;
    updateCcTurnTracker(tracker, type, payload);
  }

  /**
   * Applied to every transcript line the tailer emits — from launch and from
   * the hook backstops alike. Updates the turn tracker and calls
   * notifyTurnStarted(): any transcript line proves CC is actively processing
   * the dispatched message, so the input-queue watchdog is cancelled and a long
   * but legitimate turn isn't mistaken for a swallowed message.
   */
  function onCcTranscriptEvent(
    session: Session,
    type: string,
    payload: unknown,
  ): void {
    updateTurnTracker(session.oakridgeSid, type, payload);
    session.notifyTurnStarted();
  }

  // === AgentRuntime implementation ===

  const runtime: AgentRuntime & AppRuntime = {
    id: "claude-code",
    descriptor: CC_DESCRIPTOR,
    isAllowedModel: (model: string) => (ALLOWED_MODELS as readonly string[]).includes(model),

    // --- AgentRuntime.spawn ---
    async spawn(config: RuntimeConfig): Promise<SessionHandle> {
      const oakridgeSid =
        (config.runtimeSpecific?.oakridgeSid as string | undefined) ??
        Math.random().toString(36).slice(2);
      const model = config.runtimeSpecific?.model as string | null | undefined;
      const parentCcSid = config.runtimeSpecific?.parentCcSid as
        | string
        | null
        | undefined;

      const spawnEnv: Record<string, string | undefined> = {
        ...process.env,
      };

      // We assign CC's session id ourselves rather than discover it from a
      // parsed system/init event — in PTY mode the byte stream is never parsed,
      // so this is the only point at which the ccSid → oakridgeSid mapping can
      // be established. Returning it as the handle's runtimeSid drives
      // observeRuntimeSessionId → onRuntimeSessionObserved → registerCcSid, so
      // the hook routes can resolve the session by the session_id CC stamps on
      // every hook payload. Without this the PermissionRequest gate would never
      // find the session and would deny every request.
      const ccSessionId = randomUUID();

      // Allocate per-session channel outbox file. The channel-server (spawned
      // by CC as an MCP stdio server) tails this file and pushes each line as
      // a `notifications/claude/channel` notification. Creating it empty here
      // guarantees it exists when CC starts the channel server, avoiding any
      // ENOENT during the initial tail. The file lives in dataDir alongside
      // settings.json and mcp-servers.json so all session artifacts are in one
      // place and cleaned up together.
      const channelOutboxPath = join(opts.dataDir, `channel-outbox-${oakridgeSid}.jsonl`);
      await writeFile(channelOutboxPath, "");

      // Write the per-session MCP config that includes the channel server with
      // this session's outbox path. Must be per-session (not shared) because
      // KBBL_CHANNEL_OUTBOX differs across sessions.
      const mcpConfigPath = await writeCcMcpConfig({
        dataDir: opts.dataDir,
        channelOutboxPath,
        bunBin,
        channelServerPath,
      });

      // Build interactive argv (no --print / stream-json) via the shared,
      // unit-tested builder so the argv exercised by spawn.test.ts is exactly
      // the one launched here. --fork-session (added when parentCcSid is set) is
      // required for CC to accept our forced --session-id alongside --resume.
      // Channel flags are appended last (variadic — see buildCcArgv).
      const argv = buildCcArgv({
        claudeBin: opts.claudeBin,
        settingsPath,
        mcpConfigPath,
        model,
        parentCcSid,
        sessionId: ccSessionId,
      });

      // A.1: hard billing invariant — refuse rather than downgrade. Returns the
      // realpath-resolved binary; we spawn THAT (not opts.claudeBin) so a
      // relative path can't validate here yet resolve to a different file under
      // the session's cwd, slipping past the billing guard.
      const resolvedClaudeBin = await assertA1Invariants({
        claudeBin: opts.claudeBin,
        argv,
        env: spawnEnv,
      });

      // Strip undefined values — bun-pty requires Record<string, string>.
      const ptyEnv = Object.fromEntries(
        Object.entries(spawnEnv).filter((e): e is [string, string] => e[1] !== undefined),
      );

      // Pre-trust the worktree so CC's launch skips the workspace-trust modal.
      // Without this the modal blocks the prompt in PTY mode and swallows the
      // operator's first message. Best-effort — see ensureWorkspaceTrusted.
      await ensureWorkspaceTrusted(config.workingDirectory);

      // Launch claude in a PTY (invariant 4: real TTY guaranteed by bun-pty).
      const ptyProc = pty.spawn(resolvedClaudeBin, argv.slice(1), {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: config.workingDirectory,
        env: ptyEnv,
      });

      // Readiness gate: send() awaits this so the first operator message isn't
      // written before CC's REPL is reading stdin. Resolved (whichever comes
      // first) by the first PTY output (events()), the fallback timer below, or
      // process exit. The resolver clears the fallback so a session that became
      // ready via real output doesn't leave a timer to fire later.
      let readyFallback: ReturnType<typeof setTimeout> | null = null;
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = () => {
          if (readyFallback !== null) {
            clearTimeout(readyFallback);
            readyFallback = null;
          }
          resolve();
        };
      });

      const handle: CcHandle = {
        sessionId: oakridgeSid,
        pty: ptyProc,
        exited: null,
        notifyExit: null,
        ready,
        markReady,
        cwd: config.workingDirectory,
        ccSessionId,
        // Seed to launch time so quiescence isn't declared before any output;
        // the ready gate (first output) precedes any send() quiescence check.
        lastOutputAt: Date.now(),
        channelOutboxPath,
        // Guard: the dev-channels modal acceptance fires at most once per session.
        devChannelsAccepted: false,
      };
      procs.set(oakridgeSid, handle);

      // Fallback: resolve readiness even if CC emits no output, so send() can
      // never hang on a silent/broken launch. unref so it can't keep the loop
      // alive on its own; markReady is idempotent so a later real signal is a
      // no-op.
      readyFallback = setTimeout(() => handle.markReady(), READY_FALLBACK_MS);
      readyFallback.unref?.();

      // Track PTY output from the moment the process exists — NOT only once the
      // events() generator starts consuming. _wireAttached can pump the queue
      // (runtime.send) before it begins iterating runtime.events(), so a send
      // dispatched in that window would otherwise read a stale lastOutputAt and
      // wrongly pass the quiescence gate while CC is still spinning. This
      // listener keeps markReady (readiness) and lastOutputAt (quiescence) live
      // independent of events(); events()'s own listener handles pty_output
      // streaming. Disposed on exit so it can't outlive the process.
      //
      // Additionally: when the dev-channels warning modal appears (detected by
      // /development/i in the PTY output), accept it with a single `\r`. This
      // modal is a one-time, pre-REPL confirmation; CC is blocking on exactly
      // this input, so writing `\r` here is categorically safe — unlike the
      // recurring bug where prompts were written mid-turn. The guard ensures
      // we fire at most once per session. Workspace-trust is already handled
      // by ensureWorkspaceTrusted() above, so this is the only remaining modal.
      const outputDisposable = ptyProc.onData((data: string) => {
        handle.markReady();
        handle.lastOutputAt = Date.now();
        if (!handle.devChannelsAccepted && /development/i.test(data)) {
          handle.devChannelsAccepted = true;
          try {
            ptyProc.write("\r");
          } catch {
            // PTY may have already exited — ignore.
          }
        }
      });

      // Register exit handling immediately — not in events() — so a process
      // that dies before events() is entered still records its exit. We record
      // the code on the handle and wake any active consumer; we deliberately do
      // NOT delete from procs here, so events() (entered after a fast exit) can
      // still find the handle and replay the completion. procs cleanup is owned
      // by events()'s finally on the normal path, and by terminate() as the
      // backstop if events() is never consumed.
      ptyProc.onExit(({ exitCode }) => {
        handle.exited = { code: exitCode };
        // Unblock any send() waiting on readiness — the process is gone, so the
        // write will fail fast rather than hang forever on `ready`. markReady
        // also clears the fallback timer.
        handle.markReady();
        outputDisposable.dispose();
        handle.notifyExit?.();
      });

      return { sessionId: oakridgeSid, runtimeSid: ccSessionId };
    },

    // --- AgentRuntime.terminate ---
    async terminate(handle: SessionHandle): Promise<void> {
      const h = procs.get(handle.sessionId);
      if (h) {
        try {
          h.pty.kill();
        } catch {
          // already dead
        }
        // Backstop cleanup: events() owns procs.delete on the normal path, but
        // if a session is terminated before its events() generator is consumed
        // the handle would otherwise linger. Safe to delete unconditionally —
        // events()'s own delete is idempotent.
        procs.delete(handle.sessionId);
      }
    },

    // --- AgentRuntime.events ---
    async *events(handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      const maybeHandle = procs.get(handle.sessionId);
      if (!maybeHandle) return;
      // Explicit non-nullable binding: TS does not preserve the `!maybeHandle`
      // narrowing into the nested deliverExit() closure, so alias it here.
      const live: CcHandle = maybeHandle;
      const { pty: ptyProc } = live;

      const queue: RuntimeEvent[] = [];
      let queueResolve: (() => void) | null = null;
      let done = false;

      function push(evt: RuntimeEvent): void {
        queue.push(evt);
        queueResolve?.();
        queueResolve = null;
      }

      function waitForItem(): Promise<void> {
        if (queue.length > 0) return Promise.resolve();
        return new Promise<void>((r) => {
          queueResolve = r;
        });
      }

      // Raw PTY byte stream — break-glass only (A.6). Never parsed for content.
      // Coalesce chunks within a macrotask tick before emitting: a verbose TUI
      // can fire onData many times per frame, and emitting one RuntimeEvent per
      // raw chunk lets the in-memory queue grow without bound and writes a flood
      // of tiny records. We buffer arriving chunks and flush a single
      // pty_output per tick, bounding both event count and per-event overhead.
      let pendingOutput = "";
      let flushScheduled = false;
      function flushOutput(): void {
        flushScheduled = false;
        if (pendingOutput.length === 0) return;
        const content = pendingOutput;
        pendingOutput = "";
        push({ type: "envelope", payload: { type: "pty_output", content } });
      }
      const dataDisposable = ptyProc.onData((data) => {
        // readiness (markReady) and output-recency (lastOutputAt) are owned by
        // the spawn()-level onData listener so they stay correct even before
        // this generator starts consuming. Here we only buffer for pty_output.
        pendingOutput += data;
        if (!flushScheduled) {
          flushScheduled = true;
          setTimeout(flushOutput, 0);
        }
      });

      // Start the transcript tailer at launch — not on the first hook. In PTY
      // mode the on-disk transcript is the only content signal: it drives the
      // Conversation view AND notifyTurnStarted (which cancels the input-queue
      // watchdog). Deriving the path here (rather than waiting for a hook to
      // report transcript_path) makes turn-start detection independent of which
      // hook arrives first — SessionStart is not guaranteed, and a plain text
      // turn fires no tool/permission hook. The tailer tolerates the file not
      // existing yet (it polls until CC writes the first line). The hook-driven
      // ensureTranscriptTailer calls remain as idempotent backstops.
      const tailSession = oakridgeSidToSession.get(handle.sessionId);
      if (tailSession) {
        ensureTranscriptTailer(
          tailSession,
          ccTranscriptPath(live.cwd, live.ccSessionId),
          (type, payload) => onCcTranscriptEvent(tailSession, type, payload),
        );
      }

      // Surface the process exit as a completion event. onExit is registered in
      // spawn() (so it fires regardless of this generator); here we install the
      // wake hook and also replay synchronously if the PTY already exited during
      // the window between spawn() returning and this generator being entered.
      function deliverExit(): void {
        if (done) return;
        flushOutput();
        push({ type: "completed", result: { code: live.exited?.code ?? 0 } });
        done = true;
        queueResolve?.();
        queueResolve = null;
      }
      live.notifyExit = deliverExit;
      if (live.exited) deliverExit();

      try {
        while (true) {
          await waitForItem();
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (done) break;
        }
      } finally {
        dataDisposable.dispose();
        live.notifyExit = null;
        procs.delete(handle.sessionId);
      }
    },

    // --- AgentRuntime.send ---
    async send(handle: SessionHandle, input: string): Promise<void> {
      const h = procs.get(handle.sessionId);
      if (!h) throw new Error(`no proc for session ${handle.sessionId}`);
      // Channel transport: append one line to the session's outbox file.
      // The channel server (spawned by CC as a stdio MCP server) tails the
      // file and pushes each line as `notifications/claude/channel`. CC
      // treats the push as a user turn — functionally identical to typed
      // input but without any PTY write race.
      //
      // No PTY quiescence gate needed: the channel delivers to CC's native
      // message handler, not to its input box, so there is no "busy window"
      // to avoid. The per-session turn queue in Session (pumpInputQueue) still
      // ensures only one operator message is in flight at a time — we just
      // removed the last source of fragility (raw PTY byte injection).
      const line = JSON.stringify({ content: input, meta: { source: "kbbl" } }) + "\n";
      await writeFile(h.channelOutboxPath, line, { flag: "a" });
    },

    // --- AgentRuntime.resolveResumeRef ---
    async resolveResumeRef(
      sessionsDir: string,
      oakridgeSid: string,
    ): Promise<ResumeRef> {
      const jsonlPath = join(sessionsDir, `${oakridgeSid}.jsonl`);
      let contents: string;
      try {
        contents = await readJsonlOrEmpty(jsonlPath);
      } catch (err) {
        console.error(
          `kbbl: failed to read parent jsonl ${jsonlPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { kind: "unknown" };
      }
      if (!contents) return { kind: "unknown" };

      let runtimeSid: string | null = null;
      let workdir: string | null = null;
      let parentWorktreePath: string | null = null;
      let model: string | null = null;

      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let evt: EnvelopeEvent;
        try {
          evt = JSON.parse(line) as EnvelopeEvent;
        } catch {
          continue;
        }
        const payload =
          typeof evt.payload === "object" && evt.payload !== null
            ? (evt.payload as Record<string, unknown>)
            : {};

        if (
          (evt.type === "cc_session_id_observed" ||
            evt.type === "runtime_session_observed") &&
          typeof payload.cc_session_id === "string"
        ) {
          runtimeSid = payload.cc_session_id;
        }
        if (
          evt.type === "runtime_session_observed" &&
          typeof payload.runtime_sid === "string"
        ) {
          runtimeSid = payload.runtime_sid;
        }
        if (evt.type === "session_started") {
          if (typeof payload.workdir === "string") workdir = payload.workdir;
          if (typeof payload.worktreePath === "string")
            parentWorktreePath = payload.worktreePath;
          if (typeof payload.model === "string") model = payload.model;
        }
        if (runtimeSid && workdir) break;
      }

      if (!runtimeSid) return { kind: "no_runtime_sid" };
      if (!workdir) return { kind: "no_workdir" };
      return { kind: "ok", runtimeSid, workdir, parentWorktreePath, model };
    },

    // --- AgentRuntime.reconstructSnapshot ---
    reconstructSnapshot(events: readonly EnvelopeEvent[]): RuntimeSnapshotContrib {
      let runtimeSid: string | null = null;
      let yoloMode = false;
      const allowedTools = new Set<string>();
      let lastResultUsage = null as ReturnType<typeof extractResultUsage>;
      let observedModel: string | null = null;
      let initialObservedModel: string | null = null;

      for (const evt of events) {
        const payload =
          typeof evt.payload === "object" && evt.payload !== null
            ? (evt.payload as Record<string, unknown>)
            : {};

        switch (evt.type) {
          case "cc_session_id_observed":
            if (typeof payload.cc_session_id === "string")
              runtimeSid = payload.cc_session_id;
            break;
          case "runtime_session_observed":
            if (typeof payload.runtime_sid === "string")
              runtimeSid = payload.runtime_sid;
            break;
          case "tool_allowlisted":
            if (typeof payload.tool_name === "string")
              allowedTools.add(payload.tool_name);
            break;
          case "yolo_mode_changed":
            if (typeof payload.enabled === "boolean") yoloMode = payload.enabled;
            break;
          case "result": {
            const usage = extractResultUsage(payload);
            if (usage) lastResultUsage = usage;
            break;
          }
          case "model_observed":
            if (typeof payload.model === "string") {
              if (initialObservedModel === null) initialObservedModel = payload.model;
              observedModel = payload.model;
            }
            break;
          case "system": {
            if (observedModel === null && payload.subtype === "init" && typeof payload.model === "string") {
              if (initialObservedModel === null) initialObservedModel = payload.model;
              observedModel = payload.model;
            }
            break;
          }
          case "assistant": {
            const msg = payload.message as { model?: unknown } | undefined;
            if (msg && typeof msg.model === "string") {
              if (initialObservedModel === null) initialObservedModel = msg.model;
              observedModel = msg.model;
            }
            break;
          }
        }
      }

      return {
        runtimeSid,
        yoloMode,
        allowedTools: [...allowedTools],
        lastResultUsage,
        initialObservedModel,
        observedModel,
      };
    },

    // --- AgentRuntime.classifyEvent ---
    classifyEvent: classifyCcEvent,

    // pty_output is the raw break-glass byte stream: high-volume and not a
    // canonical structured transcript event. Broadcast it live over SSE (the
    // xterm view consumes it) but keep it out of the JSONL so transcripts stay
    // small and replays fast. (No stream_event records exist in PTY mode — the
    // byte stream is never parsed — so it needs no entry here.)
    nonPersistedEventTypes: new Set<string>(["pty_output"]),

    // Do NOT synthesize: CC DOES echo operator input — it writes every channel
    // push into its transcript as a channel-origin `user` row when it actually
    // ingests the message, and the transcript transform surfaces that
    // (unwrapped) as the `user` event. Synthesizing as well would double the
    // message AND insert it into the flow before CC has processed it; leaving it
    // to the transcript means the operator's message lands in the conversation
    // only once CC has actually picked it up (the optimistic pending bubble
    // holds at the bottom until then). We also do NOT set sendsWithoutTurnQueue:
    // CC's Stop hook drives the turn queue, so input stays on the
    // pumpInputQueue/notifyTurnEnd delivery path.
    synthesizeUserInputEvents: false,

    // --- AgentRuntime.mountRoutes ---
    mountRoutes(
      app: Hono,
      deps: {
        manager: SessionManager;
        getBunServer: () => import("bun").Server<unknown> | null;
      },
    ): void {
      // Wire the CC session-id registry into the manager. The manager's
      // getByCcSid delegates to opts.lookupByCcSid, which we set below.
      // We also need to capture session references for the lookupByCcSid path.
      // This is done by hooking into onRuntimeSessionObserved / onRuntimeSessionEnded
      // on the manager opts — but mountRoutes is called after the manager is
      // created, so we can't modify opts here. Instead, we use a monkey-patch
      // approach: replace getByCcSid on the manager instance with a version
      // that checks our own map.
      //
      // NOTE: This is a bridge for the transition period. In the full registry
      // path (server.ts wired with createRuntimeRegistry), the manager is
      // constructed with lookupByCcSid + onRuntimeSessionObserved callbacks
      // pointing to this adapter. The monkey-patch here supports the legacy
      // AppRuntime path where the manager has no registry.
      const origGet = deps.manager.getByCcSid.bind(deps.manager);
      (deps.manager as { getByCcSid: (ccSid: string) => Session | undefined }).getByCcSid =
        (ccSid: string) => origGet(ccSid) ?? lookupByCcSid(ccSid);

      const hookDeps: HookHandlerDeps = {
        manager: deps.manager,
        getBunServer: deps.getBunServer,
        subagentCounts,
        turnTrackers,
        onTranscriptEvent: onCcTranscriptEvent,
      };
      app.post("/hook/permission", hookPermissionHandler(hookDeps));
      app.post("/hook/tool", hookPostToolUseHandler(hookDeps));
      app.post("/hook/stop", hookStopHandler(hookDeps));
      app.post("/hook/session-start", hookSessionStartHandler(hookDeps));
      app.post("/hook/session-end", hookSessionEndHandler(hookDeps));
      app.post("/hook/notification", hookNotificationHandler(hookDeps));
      app.post("/hook/subagent-start", hookSubagentStartHandler(hookDeps));
      app.post("/hook/subagent-stop", hookSubagentStopHandler(hookDeps));
    },

    // --- Legacy AppRuntime.buildSpawnCmd (registry-only adapter: refuse) ---
    // The PTY billing transport is fundamentally incompatible with the legacy
    // buildSpawnCmd + Session.spawn() path: that path JSON.parses every stdout
    // line, but interactive `claude` (no --print/stream-json) emits raw TUI
    // bytes, which would spew subprocess_stdout_parse_error continuously.
    // Emitting --print/stream-json argv here to satisfy the parser is worse —
    // --print routes the session through API-priced billing, defeating the A.1
    // invariant this whole transport exists to enforce. So fail loud: this
    // adapter is registry-only. SessionManager always takes the registry path
    // when a registry is configured (server.ts wires both); this throw only
    // fires if a manager is built with buildSpawnCmd and no registry.
    buildSpawnCmd: (_session: Session): Promise<SpawnCmd> => {
      throw new Error(
        "claude-code adapter is registry-only: the PTY billing transport cannot " +
          "use the legacy buildSpawnCmd + Session.spawn() stdout-parse path " +
          "(it would either break on raw TUI bytes or fall back to API-priced " +
          "--print). Configure SessionManager with opts.registry, not buildSpawnCmd.",
      );
    },
  };

  // Export the lookup + registry functions for server.ts to wire.
  (runtime as unknown as {
    registerCcSid: typeof registerCcSid;
    unregisterBySid: typeof unregisterBySid;
    lookupByCcSid: typeof lookupByCcSid;
    trackSession: (s: Session) => void;
  }).registerCcSid = registerCcSid;
  (runtime as unknown as {
    registerCcSid: typeof registerCcSid;
    unregisterBySid: typeof unregisterBySid;
    lookupByCcSid: typeof lookupByCcSid;
    trackSession: (s: Session) => void;
  }).unregisterBySid = unregisterBySid;
  (runtime as unknown as {
    registerCcSid: typeof registerCcSid;
    unregisterBySid: typeof unregisterBySid;
    lookupByCcSid: typeof lookupByCcSid;
    trackSession: (s: Session) => void;
  }).lookupByCcSid = lookupByCcSid;
  (runtime as unknown as {
    registerCcSid: typeof registerCcSid;
    unregisterBySid: typeof unregisterBySid;
    lookupByCcSid: typeof lookupByCcSid;
    trackSession: (s: Session) => void;
  }).trackSession = (s: Session) => {
    oakridgeSidToSession.set(s.oakridgeSid, s);
    turnTrackers.set(s.oakridgeSid, { resultedThisTurn: false, lastAssistantUsage: null });
  };

  return runtime;
}
