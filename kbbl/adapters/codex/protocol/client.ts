// CodexAppServerClient: JSONRPC-like client over a CodexTransport.
//
// Protocol notes (from probe findings):
// - Inbound messages MUST NOT require jsonrpc:"2.0" — Codex omits it.
// - Integer IDs: server-initiated requests use integer ids. Client requests use UUID strings.
// - Approval methods: item/fileChange/requestApproval, item/commandExecution/requestApproval only.

import { randomUUID } from "node:crypto";
import type { CodexTransport } from "./transport";
import type {
  InitializeParams,
  InitializeResult,
  ThreadStartParams,
  ThreadStartResult,
  ThreadForkParams,
  ThreadForkResult,
  ThreadUnsubscribeResult,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
} from "./generated/types";

/**
 * `turn/start` gained an `effort` field (the app-server `ReasoningEffort` enum)
 * in codex-cli after these bindings were last regenerated (0.133.0). Rather
 * than regenerate the entire protocol for one field, widen this single call's
 * params here. `effort` overrides the thread's reasoning effort for this turn
 * and subsequent turns; values are gated against RuntimeDescriptor.efforts
 * before reaching this layer, so a plain `string` is honest on the wire.
 */
export type TurnStartParamsWithEffort = TurnStartParams & { effort?: string };

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

type PendingEntry = {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
};

export class CodexAppServerClient {
  private readonly transport: CodexTransport;
  /** Client-initiated pending requests keyed by their UUID string id */
  private readonly pending = new Map<string | number, PendingEntry>();
  /** Thread-scoped notification subscribers, keyed by threadId */
  private readonly threadNotifHandlers = new Map<
    string,
    Set<(n: CodexNotification) => void>
  >();
  /**
   * Server-request handlers keyed by threadId. null key = global fallback.
   * Set before subscribing to thread notifications so approval requests
   * that arrive before the subscription is active still route correctly.
   */
  private readonly serverRequestHandlers = new Map<
    string | null,
    (r: CodexServerRequest) => Promise<void>
  >();
  private _closed = false;

  constructor(transport: CodexTransport) {
    this.transport = transport;
    transport.onClose(() => {
      this._closed = true;
      const err = new Error("CodexAppServerClient: transport closed");
      for (const entry of this.pending.values()) {
        entry.reject(err);
      }
      this.pending.clear();
    });
    // Start the read loop in background
    this._readLoop().catch((err) => {
      console.error("CodexAppServerClient: read loop error:", err);
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  private async _readLoop(): Promise<void> {
    for await (const line of this.transport.lines()) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        console.error("CodexAppServerClient: failed to parse line:", line);
        continue;
      }

      // Determine message type — NOTE: do NOT require jsonrpc:"2.0" field.
      if ("result" in msg) {
        // Server response (success)
        const id = msg.id as string | number;
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.resolve(msg.result);
        }
      } else if ("error" in msg) {
        // Server response (error)
        const id = msg.id as string | number;
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          const errObj = msg.error as { message?: string; code?: number } | null;
          const err = new Error(
            `CodexAppServer error: ${errObj?.message ?? JSON.stringify(msg.error)}`,
          );
          // Preserve the numeric JSON-RPC code so callers can distinguish failure
          // modes (e.g. -32601 Method not found) without parsing the message text.
          if (typeof errObj?.code === "number") {
            (err as Error & { code?: number }).code = errObj.code;
          }
          entry.reject(err);
        }
      } else if ("method" in msg && !("id" in msg)) {
        // Server → client notification (no id)
        const method = msg.method as string;
        const params = msg.params;
        const threadId = (params as { threadId?: unknown })?.threadId;
        if (typeof threadId === "string") {
          const handlers = this.threadNotifHandlers.get(threadId);
          if (handlers) {
            for (const h of handlers) {
              try {
                h({ method, params });
              } catch (e) {
                console.error("CodexAppServerClient: notification handler error:", e);
              }
            }
          }
        }
      } else if ("method" in msg && "id" in msg) {
        // Server → client server-request (has id — approval requests)
        const reqId = msg.id as string | number;
        const method = msg.method as string;
        const params = msg.params;
        const threadId = (params as { threadId?: unknown })?.threadId;
        const req: CodexServerRequest = { id: reqId, method, params };

        // Route to thread-specific handler first, then global fallback
        let handler: ((r: CodexServerRequest) => Promise<void>) | undefined;
        if (typeof threadId === "string") {
          handler = this.serverRequestHandlers.get(threadId);
        }
        if (!handler) {
          handler = this.serverRequestHandlers.get(null) ?? undefined;
        }

        if (handler) {
          handler(req).catch(async (e) => {
            console.error("CodexAppServerClient: server-request handler error:", e);
            await this.sendServerResponse(reqId, { decision: "cancel" }).catch(() => {});
          });
        } else {
          // No handler — send cancel response so codex doesn't hang
          this.sendServerResponse(reqId, { decision: "cancel" }).catch(() => {});
        }
      }
    }
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const id = randomUUID();
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      this.transport.writeLine(msg).catch((err) => {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Subscribe to notifications for a given threadId. Returns unsubscribe fn. */
  subscribeThread(
    threadId: string,
    handler: (n: CodexNotification) => void,
  ): () => void {
    let set = this.threadNotifHandlers.get(threadId);
    if (!set) {
      set = new Set();
      this.threadNotifHandlers.set(threadId, set);
    }
    set.add(handler);
    return () => {
      const s = this.threadNotifHandlers.get(threadId);
      if (s) {
        s.delete(handler);
        if (s.size === 0) this.threadNotifHandlers.delete(threadId);
      }
    };
  }

  /**
   * Set (or clear) the server-request handler for a specific threadId.
   * Pass null for threadId to set a global fallback.
   * Pass null for handler to clear the handler.
   */
  setServerRequestHandler(
    threadId: string | null,
    handler: ((r: CodexServerRequest) => Promise<void>) | null,
  ): void {
    if (handler === null) {
      this.serverRequestHandlers.delete(threadId);
    } else {
      this.serverRequestHandlers.set(threadId, handler);
    }
  }

  async sendServerResponse(id: string | number, result: unknown): Promise<void> {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    await this.transport.writeLine(msg);
  }

  // === Typed convenience methods ===

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.request<InitializeResult>("initialize", params);
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>("thread/start", params);
  }

  async threadFork(params: ThreadForkParams): Promise<ThreadForkResult> {
    return this.request<ThreadForkResult>("thread/fork", params);
  }

  async threadUnsubscribe(threadId: string): Promise<ThreadUnsubscribeResult> {
    return this.request<ThreadUnsubscribeResult>("thread/unsubscribe", {
      threadId,
    });
  }

  async turnStart(params: TurnStartParamsWithEffort): Promise<TurnStartResult> {
    return this.request<TurnStartResult>("turn/start", params);
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<void> {
    return this.request<void>("turn/interrupt", params);
  }
}
