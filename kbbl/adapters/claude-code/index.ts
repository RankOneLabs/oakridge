import type { Hono } from "hono";
import { join } from "node:path";

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
import { hookApprovalHandler } from "./hook-route";
import { makeBuildSpawnCmd, writeCcSettings } from "./spawn";

export interface CreateClaudeCodeRuntimeOpts {
  claudeBin: string;
  /** Server's HTTP port — passed into the gate via KBBL_PORT env var. */
  port: number;
  /** Directory where the generated settings.json lives. */
  dataDir: string;
  /** Absolute path to the PreToolUse gate script. */
  gatePath: string;
}

/** CC-specific session handle with a direct reference to the spawned proc. */
interface CcHandle {
  readonly sessionId: string;
  proc: ReturnType<typeof Bun.spawn>;
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
    gatePath: opts.gatePath,
  });
  const buildSpawnCmdFn = makeBuildSpawnCmd({
    claudeBin: opts.claudeBin,
    port: opts.port,
    settingsPath,
  });

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
  }

  function lookupByCcSid(ccSid: string): Session | undefined {
    const oakridgeSid = ccSidToOakridgeSid.get(ccSid);
    return oakridgeSid ? oakridgeSidToSession.get(oakridgeSid) : undefined;
  }

  // === in-flight process map ===
  const procs = new Map<string, CcHandle>();

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

      // Build argv the same way buildSpawnCmd does, but inline so we can
      // use the RuntimeConfig values without a full Session object.
      const cmd = [
        opts.claudeBin,
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-hook-events",
        "--include-partial-messages",
        "--replay-user-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--settings",
        settingsPath,
      ];

      if (model) cmd.push("--model", model);
      if (parentCcSid) cmd.push("--resume", parentCcSid, "--fork-session");

      const proc = Bun.spawn({
        cmd,
        cwd: config.workingDirectory,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          KBBL_PORT: String(opts.port),
        } as Record<string, string>,
      });

      const handle: CcHandle = { sessionId: oakridgeSid, proc };
      procs.set(oakridgeSid, handle);
      return { sessionId: oakridgeSid };
    },

    // --- AgentRuntime.terminate ---
    async terminate(handle: SessionHandle): Promise<void> {
      const h = procs.get(handle.sessionId);
      if (h) {
        try {
          h.proc.kill();
        } catch {
          // already dead
        }
      }
    },

    // --- AgentRuntime.events ---
    async *events(handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      const h = procs.get(handle.sessionId);
      if (!h) return;
      const { proc } = h;

      const procStdout = proc.stdout as ReadableStream<Uint8Array>;
      const procStderr = proc.stderr as ReadableStream<Uint8Array>;

      // Use a shared event queue to merge stdout + stderr lines.
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

      const stdoutPump = (async () => {
        for await (const line of readLines(procStdout)) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);
            push({ type: "envelope", payload: raw });
          } catch {
            push({
              type: "envelope",
              payload: { type: "subprocess_stdout_parse_error", line },
            });
          }
        }
      })();

      const stderrPump = (async () => {
        for await (const line of readLines(procStderr)) {
          push({ type: "envelope", payload: { type: "subprocess_stderr", line } });
        }
      })();

      // Drive all three (stdout, stderr, exit) concurrently; signal done
      // once both pumps + exit have finished.
      const allDone = Promise.allSettled([stdoutPump, stderrPump]).then(
        async () => {
          const exitCode = await proc.exited;
          push({ type: "completed", result: { code: exitCode } });
          done = true;
          queueResolve?.();
          queueResolve = null;
          // Clean up the proc map once we've drained.
          procs.delete(handle.sessionId);
        },
      );

      // Yield items as they arrive. try/finally ensures allDone runs even if
      // the consumer breaks early (e.g. session abort), so procs.delete fires.
      try {
        while (true) {
          await waitForItem();
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (done) break;
        }
      } finally {
        await allDone.catch(() => {});
      }
    },

    // --- AgentRuntime.send ---
    async send(handle: SessionHandle, input: string): Promise<void> {
      const h = procs.get(handle.sessionId);
      if (!h) throw new Error(`no proc for session ${handle.sessionId}`);
      const stdin = h.proc.stdin as import("bun").FileSink;
      const line =
        JSON.stringify({
          type: "user",
          message: { role: "user", content: input },
        }) + "\n";
      stdin.write(line);
      await stdin.flush();
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
            if (typeof payload.model === "string") observedModel = payload.model;
            break;
          case "system": {
            if (observedModel === null && payload.subtype === "init" && typeof payload.model === "string") {
              observedModel = payload.model;
            }
            break;
          }
          case "assistant": {
            const msg = payload.message as { model?: unknown } | undefined;
            if (msg && typeof msg.model === "string") observedModel = msg.model;
            break;
          }
        }
      }

      return {
        runtimeSid,
        yoloMode,
        allowedTools: [...allowedTools],
        lastResultUsage,
        observedModel,
      };
    },

    // --- AgentRuntime.classifyEvent ---
    classifyEvent: classifyCcEvent,

    // CC's --include-partial-messages emits one stream_event per delta —
    // many thousands per long turn. Subscribers (the PWA's
    // InFlightAssistantRow) need them live, but the canonical transcript
    // record is the final `assistant` event that follows.
    nonPersistedEventTypes: new Set(["stream_event"]),

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

      app.post(
        "/hook/approval",
        hookApprovalHandler({
          manager: deps.manager,
          getBunServer: deps.getBunServer,
        }),
      );
    },

    // --- Legacy AppRuntime.buildSpawnCmd ---
    buildSpawnCmd: (session: Session): Promise<SpawnCmd> => {
      // Track the session so lookupByCcSid works in legacy mode.
      oakridgeSidToSession.set(session.oakridgeSid, session);
      return buildSpawnCmdFn(session);
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
  };

  return runtime;
}

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const trimCR = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0) yield trimCR(buf);
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        yield trimCR(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
