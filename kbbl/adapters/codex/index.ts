// Codex adapter: implements the AgentRuntime interface backed by the Codex app-server.

import { randomUUID } from "node:crypto";

import type {
  AgentRuntime,
  ApprovalDecision,
  ResumeRef,
  RuntimeConfig,
  RuntimeDescriptor,
  RuntimeEvent,
  RuntimeSnapshotContrib,
  SessionHandle,
} from "../../core/runtime";
import type { EnvelopeEvent, Session } from "../../core/session/session";
import { extractResultUsage } from "../../core/session/session";

import { startCodexAppServer, type CodexAppServerOpts } from "./app-server";
import type { CodexModel } from "./models";
import {
  normalizeNotification,
  extractTurnUsage,
  CODEX_NON_PERSISTED_EVENT_TYPES,
} from "./events";
import type { ResultUsage } from "../../core/session/session";
import { normalizeApprovalByMethod } from "./approvals";
import { resolveCodexResumeRef } from "./resume";

// === Per-session state ===

interface CodexSessionState {
  threadId: string;
  activeTurnId: string | null;
  /** kbbl request id → resolver fn (called when operator decides) */
  approvalResolvers: Map<string, (d: "allow" | "deny") => void>;
  /** Per-turn token usage keyed by turnId; consumed by classifyEvent on the matching result */
  lastTokenUsage: { turnId: string; inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

// === Descriptor-only factory (for conformance tests without a live server) ===

/**
 * Creates a Codex runtime instance in "disconnected" mode.
 * The descriptor, reconstructSnapshot, and resolveResumeRef work normally.
 * spawn/events/terminate/send require a real client and will throw.
 */
export function createCodexRuntimeDescriptorOnly(
  models: CodexModel[] = [],
): AgentRuntime {
  const descriptor: RuntimeDescriptor = {
    id: "codex",
    label: "Codex",
    models,
    supportsCompaction: false,
  };

  return {
    id: "codex",
    descriptor,
    nonPersistedEventTypes: CODEX_NON_PERSISTED_EVENT_TYPES,

    async spawn(): Promise<SessionHandle> {
      throw new Error("createCodexRuntimeDescriptorOnly: spawn not supported (no client)");
    },
    async terminate(): Promise<void> {},
    async *events(): AsyncIterable<RuntimeEvent> {},
    async send(): Promise<void> {
      throw new Error("createCodexRuntimeDescriptorOnly: send not supported (no client)");
    },

    async resolveResumeRef(sessionsDir, oakridgeSid): Promise<ResumeRef> {
      return resolveCodexResumeRef(sessionsDir, oakridgeSid);
    },

    reconstructSnapshot,
    isAllowedModel: models.length > 0
      ? (m) => models.some((cm) => cm.value === m)
      : undefined,
  };
}

// === Shared reconstructSnapshot (no client needed) ===

function reconstructSnapshot(
  events: readonly EnvelopeEvent[],
): RuntimeSnapshotContrib {
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
      case "runtime_session_observed":
        if (typeof payload.runtime_sid === "string")
          runtimeSid = payload.runtime_sid;
        if (typeof payload.thread_id === "string")
          runtimeSid = payload.thread_id;
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
    }
  }

  return {
    runtimeSid,
    yoloMode,
    allowedTools: [...allowedTools],
    lastResultUsage,
    observedModel,
  };
}

// === Full runtime factory ===

export interface CreateCodexRuntimeOpts extends CodexAppServerOpts {
  /** Path to the sessions directory — required for resume to work. */
  sessionsDir?: string;
}

/**
 * Start the Codex app-server and return a fully wired AgentRuntime.
 * Throws if the app-server fails to start (caller should catch and
 * continue without Codex — see server.ts wiring).
 */
export async function createCodexRuntime(
  opts: CreateCodexRuntimeOpts,
): Promise<AgentRuntime> {
  const { client, models, stop } = await startCodexAppServer(opts);
  const { sessionsDir } = opts;

  const descriptor: RuntimeDescriptor = {
    id: "codex",
    label: "Codex",
    models,
    supportsCompaction: false,
  };

  const sessions = new Map<string, CodexSessionState>();

  function getState(oakridgeSid: string): CodexSessionState | undefined {
    return sessions.get(oakridgeSid);
  }

  const runtime: AgentRuntime = {
    id: "codex",
    descriptor,
    nonPersistedEventTypes: CODEX_NON_PERSISTED_EVENT_TYPES,

    // --- spawn ---
    async spawn(config: RuntimeConfig): Promise<SessionHandle> {
      const oakridgeSid =
        (config.runtimeSpecific?.oakridgeSid as string | undefined) ??
        randomUUID();
      const cwd = config.workingDirectory;
      const model = config.runtimeSpecific?.model as string | undefined;
      const parentOakridgeSid =
        config.runtimeSpecific?.parentOakridgeSid as string | undefined;

      let threadId: string;

      // Attempt resume if a parent session oakridgeSid is provided
      if (parentOakridgeSid && sessionsDir) {
        const ref = await resolveCodexResumeRef(sessionsDir, parentOakridgeSid);
        if (ref.kind === "ok") {
          // Resume: fork off the parent thread
          // Probe finding #3: use fork response thread.id directly, no thread/started wait
          const forkResult = await client.threadFork({
            threadId: ref.runtimeSid,
            cwd,
            sandbox: "workspace-write",
            approvalPolicy: "untrusted",
            runtimeWorkspaceRoots: [cwd],
          });
          threadId = forkResult.thread.id;
        } else {
          // Resume ref unavailable — fall through to new thread
          const startResult = await client.threadStart({
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            cwd,
            sandbox: "workspace-write",
            approvalPolicy: "untrusted",
            model,
            runtimeWorkspaceRoots: [cwd],
          });
          threadId = startResult.thread.id;
        }
      } else {
        // New session
        const startResult = await client.threadStart({
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd,
          sandbox: "workspace-write",
          approvalPolicy: "untrusted",
          model,
          runtimeWorkspaceRoots: [cwd],
        });
        threadId = startResult.thread.id;
      }

      const state: CodexSessionState = {
        threadId,
        activeTurnId: null,
        approvalResolvers: new Map(),
        lastTokenUsage: null,
      };
      sessions.set(oakridgeSid, state);

      return { sessionId: oakridgeSid };
    },

    // --- terminate ---
    async terminate(handle: SessionHandle): Promise<void> {
      const state = getState(handle.sessionId);
      if (!state) return;
      try {
        // Probe finding #4: thread/unsubscribe confirmed; returns {status:"unsubscribed"}
        await client.threadUnsubscribe(state.threadId);
      } catch (err) {
        console.error(
          `kbbl codex: terminate failed for ${handle.sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Drain any pending approval resolvers so their decisionPromises don't hang
      for (const resolver of state.approvalResolvers.values()) {
        resolver("deny");
      }
      state.approvalResolvers.clear();
      sessions.delete(handle.sessionId);
    },

    // --- events ---
    async *events(handle: SessionHandle): AsyncIterable<RuntimeEvent> {
      const state = getState(handle.sessionId);
      if (!state) return;
      const { threadId } = state;

      // Event queue for producer/consumer decoupling
      const eventQueue: RuntimeEvent[] = [];
      let queueResolve: (() => void) | null = null;
      let done = false;

      function pushEvent(evt: RuntimeEvent): void {
        eventQueue.push(evt);
        queueResolve?.();
        queueResolve = null;
      }

      function waitForEvent(): Promise<void> {
        if (eventQueue.length > 0) return Promise.resolve();
        return new Promise<void>((r) => { queueResolve = r; });
      }

      // Emit runtime_session_observed so threadId is written to JSONL (enables resume)
      pushEvent({
        type: "envelope",
        payload: {
          type: "runtime_session_observed",
          runtime_id: "codex",
          runtime_sid: threadId,
        },
      });

      // Subscribe to thread notifications
      const unsub = client.subscribeThread(threadId, (notif) => {
        // Track active turn id
        if (notif.method === "turn/started") {
          const p = notif.params as { turn?: { id?: string } };
          if (p.turn?.id) state.activeTurnId = p.turn.id;
        }
        if (
          notif.method === "turn/completed" ||
          notif.method === "turn/interrupted"
        ) {
          state.activeTurnId = null;
        }

        // Capture per-turn token usage for classifyEvent → observeTurnEnd
        if (notif.method === "thread/tokenUsage/updated") {
          const p = notif.params as Parameters<typeof extractTurnUsage>[0];
          state.lastTokenUsage = { turnId: p.turnId, ...extractTurnUsage(p) };
        }

        // Normalize to kbbl event
        const evt = normalizeNotification(notif.method, notif.params);
        if (evt) {
          pushEvent({ type: "envelope", payload: evt.payload });
        }
      });

      // Set server-request handler for approval requests
      client.setServerRequestHandler(threadId, async (req) => {
        const normalized = normalizeApprovalByMethod(req.method, req.params);
        if (!normalized) {
          // Unknown method — cancel immediately
          await client.sendServerResponse(req.id, { decision: "cancel" });
          return;
        }

        // Create a kbbl-side request id and a promise that resolves when the
        // operator (or classifyEvent auto-approve) calls the resolver.
        const kbblRequestId = randomUUID();
        const decisionPromise = new Promise<"allow" | "deny">((resolve) => {
          state.approvalResolvers.set(kbblRequestId, resolve);
        });

        // Push the approval envelope — classifyEvent will pick this up and call
        // session.registerApproval or auto-approve via yolo/allowlist.
        pushEvent({
          type: "envelope",
          payload: {
            type: "codex_approval_server_request",
            kbblRequestId,
            codexId: req.id,
            method: req.method,
            params: req.params,
            toolName: normalized.toolName,
            toolInput: normalized.toolInput,
          },
        });

        // Block until the operator (or auto-approve) resolves the decision.
        const decision = await decisionPromise;
        await client.sendServerResponse(req.id, normalized.codexDecision(decision));
      });

      // Watch for transport close so we can signal done
      client["transport" as never]; // TypeScript appeasement
      const closeUnsub = (() => {
        // Register on the transport indirectly via the client's closed flag
        // by polling every 500ms — simpler than exposing transport.onClose here
        const pollInterval = setInterval(() => {
          if (client.closed) {
            clearInterval(pollInterval);
            done = true;
            queueResolve?.();
            queueResolve = null;
          }
        }, 500);
        return () => clearInterval(pollInterval);
      })();

      try {
        while (true) {
          await waitForEvent();
          while (eventQueue.length > 0) {
            const evt = eventQueue.shift()!;
            if (evt.type === "completed") {
              done = true;
              yield evt;
              return;
            }
            yield evt;
          }
          if (done) break;
        }
      } finally {
        unsub();
        closeUnsub();
        client.setServerRequestHandler(threadId, null);
      }

      yield { type: "completed", result: { code: 0 } };
    },

    // --- send ---
    async send(handle: SessionHandle, input: string): Promise<void> {
      const state = getState(handle.sessionId);
      if (!state) throw new Error(`kbbl codex: no session for ${handle.sessionId}`);
      if (state.activeTurnId !== null) {
        throw new Error(
          `kbbl codex: session ${handle.sessionId} has an active turn — cannot send`,
        );
      }

      await client.turnStart({
        threadId: state.threadId,
        input: [{ type: "text", text: input }],
      });
    },

    // --- respond (approval resolution) ---
    async respond(
      handle: SessionHandle,
      requestId: string,
      decision: ApprovalDecision,
    ): Promise<void> {
      const state = getState(handle.sessionId);
      if (!state) return;

      const resolver = state.approvalResolvers.get(requestId);
      if (resolver) {
        state.approvalResolvers.delete(requestId);
        const d =
          decision === "allow" || decision === "always_allow" ? "allow" : "deny";
        resolver(d);
      }
    },

    // --- classifyEvent ---
    async classifyEvent(rawEvent: unknown, session: Session): Promise<void> {
      if (!rawEvent || typeof rawEvent !== "object") return;
      const evt = rawEvent as { type?: unknown };

      if (evt.type === "codex_approval_server_request") {
        const e = rawEvent as {
          kbblRequestId: string;
          codexId: number | string;
          toolName: string;
          toolInput: Record<string, unknown>;
        };
        const state = getState(session.oakridgeSid);
        if (!state) return;

        // Check auto-approve conditions
        const snap = session.snapshot();
        if (
          snap.yoloMode ||
          snap.allowedTools.includes(e.toolName)
        ) {
          const resolver = state.approvalResolvers.get(e.kbblRequestId);
          if (resolver) {
            state.approvalResolvers.delete(e.kbblRequestId);
            resolver("allow");
          }
          const reason = snap.yoloMode ? "yolo" : "allowlist";
          await session.emit("permission_auto_approved", {
            tool_name: e.toolName,
            tool_input: e.toolInput,
            tool_use_id: String(e.codexId),
            reason,
          }).catch(() => {});
          return;
        }

        // Park the approval in the session for operator resolution
        session.registerApproval(e.kbblRequestId, {
          toolName: e.toolName,
          resolve: async (d) => {
            const resolver = state.approvalResolvers.get(e.kbblRequestId);
            if (resolver) {
              state.approvalResolvers.delete(e.kbblRequestId);
              resolver(d === "allow" ? "allow" : "deny");
            }
            await session.emit("permission_resolved", {
              request_id: e.kbblRequestId,
              decision: d,
            }).catch(() => {});
          },
        });
        await session.emit("permission_request", {
          request_id: e.kbblRequestId,
          tool_name: e.toolName,
          tool_input: e.toolInput,
          tool_use_id: String(e.codexId),
        });
        return;
      }

      if (evt.type === "runtime_session_observed") {
        const p = (rawEvent as { runtime_sid?: unknown; runtime_id?: unknown });
        if (
          typeof p.runtime_sid === "string" &&
          p.runtime_id === "codex"
        ) {
          await session.observeRuntimeSessionId(p.runtime_sid);
        }
        return;
      }

      if (evt.type === "usage_observation") {
        return;
      }

      if (evt.type === "result") {
        const state = getState(session.oakridgeSid);
        const p = rawEvent as { turn?: { id?: string } };
        if (state?.lastTokenUsage && state.lastTokenUsage.turnId === p.turn?.id) {
          const usage: ResultUsage = {
            input_tokens: state.lastTokenUsage.inputTokens,
            output_tokens: state.lastTokenUsage.outputTokens,
            cache_read_input_tokens: state.lastTokenUsage.cachedInputTokens,
          };
          state.lastTokenUsage = null;
          await session.observeTurnEnd({ usage, model: null });
        }
        return;
      }
    },

    // --- resolveResumeRef ---
    async resolveResumeRef(
      sessionsDir: string,
      oakridgeSid: string,
    ): Promise<ResumeRef> {
      return resolveCodexResumeRef(sessionsDir, oakridgeSid);
    },

    // --- reconstructSnapshot ---
    reconstructSnapshot,

    // --- isAllowedModel ---
    isAllowedModel: models.length > 0
      ? (m) => models.some((cm) => cm.value === m)
      : undefined,
  };

  // Override terminate to also call stop() when all sessions are gone
  const originalTerminate = runtime.terminate.bind(runtime);
  (runtime as { terminate: typeof runtime.terminate }).terminate = async (
    handle: SessionHandle,
  ) => {
    await originalTerminate(handle);
    if (sessions.size === 0) {
      // All sessions terminated — optionally stop the server.
      // We don't auto-stop since other sessions may spin up.
    }
  };

  // Expose stop for graceful shutdown
  (runtime as unknown as { stopAppServer: () => Promise<void> }).stopAppServer =
    stop;

  return runtime;
}
