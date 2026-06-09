import type { Hono } from "hono";
import { join } from "node:path";
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
} from "./hook-route";
import { assertA1Invariants, makeBuildSpawnCmd, writeCcMcpConfig, writeCcSettings } from "./spawn";

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
    port: opts.port,
  });
  const mcpConfigPath = await writeCcMcpConfig({ dataDir: opts.dataDir });
  const buildSpawnCmdFn = makeBuildSpawnCmd({
    claudeBin: opts.claudeBin,
    settingsPath,
    mcpConfigPath,
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

  // === billing observability (A.7) ===
  // Cumulative SubagentStop count per oakridgeSid for this server lifetime.
  const subagentCounts = new Map<string, number>();

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

      // Build interactive argv (no --print / stream-json).
      const argv = [
        opts.claudeBin,
        "--setting-sources",
        "user",
        "--settings",
        settingsPath,
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
      ];
      if (model) argv.push("--model", model);
      if (parentCcSid) argv.push("--resume", parentCcSid, "--fork-session");

      // A.1: hard billing invariant — refuse rather than downgrade.
      await assertA1Invariants({ claudeBin: opts.claudeBin, argv, env: spawnEnv });

      // Strip undefined values — bun-pty requires Record<string, string>.
      const ptyEnv = Object.fromEntries(
        Object.entries(spawnEnv).filter((e): e is [string, string] => e[1] !== undefined),
      );

      // Launch claude in a PTY (invariant 4: real TTY guaranteed by bun-pty).
      const ptyProc = pty.spawn(opts.claudeBin, argv.slice(1), {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: config.workingDirectory,
        env: ptyEnv,
      });

      const handle: CcHandle = { sessionId: oakridgeSid, pty: ptyProc };
      procs.set(oakridgeSid, handle);
      return { sessionId: oakridgeSid };
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
      }
    },

    // --- AgentRuntime.events ---
    async *events(handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      const h = procs.get(handle.sessionId);
      if (!h) return;
      const { pty: ptyProc } = h;

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
      // Wrapped as envelope/pty_output so the core loop persists to JSONL and
      // broadcasts over SSE (the loop only handles "envelope", not "output").
      const dataDisposable = ptyProc.onData((data) => {
        push({ type: "envelope", payload: { type: "pty_output", content: data } });
      });

      // The onExit disposable is intentionally not retained. Unlike dataDisposable
      // (disposed in finally), the onExit listener must outlive the generator: if
      // the consumer cancels early (breaks the for-await), procs.delete still fires
      // when the PTY exits, preventing a leak. push() after the generator ends is
      // harmless — the queue is GC'd with the closure once the PTY exits.
      ptyProc.onExit(({ exitCode }) => {
        push({ type: "completed", result: { code: exitCode } });
        done = true;
        queueResolve?.();
        queueResolve = null;
        procs.delete(handle.sessionId);
      });

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
      }
    },

    // --- AgentRuntime.send ---
    async send(handle: SessionHandle, input: string): Promise<void> {
      const h = procs.get(handle.sessionId);
      if (!h) throw new Error(`no proc for session ${handle.sessionId}`);
      // Bracketed paste for multiline prevents embedded \n from triggering
      // premature submission; single-line gets a bare CR (terminal Enter).
      if (input.includes("\n")) {
        h.pty.write(`\x1b[200~${input}\x1b[201~\r`);
      } else {
        h.pty.write(`${input}\r`);
      }
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

    // No stream_event records in PTY mode — the byte stream is never parsed.
    nonPersistedEventTypes: new Set<string>(),

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
