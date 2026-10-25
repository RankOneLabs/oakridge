// Bounds what kbbl queues for an SSE client that stops reading.
//
// Hono's stream writes never reject: a client that stops reading — a
// backgrounded or frozen tab, a sleeping laptop, a half-open connection —
// leaves each write pending, and a write nobody awaits queues in memory
// without bound. A session stream fed by an agent's events grows by every
// event for as long as the agent runs. The guard counts the writes still
// waiting and aborts the stream once the client has fallen too far behind
// or has read nothing for too long. Aborting cancels the response body,
// which drops the queue and runs the stream's onAbort cleanup; EventSource
// then reconnects and replays.

import type { SSEMessage, SSEStreamingApi } from "hono/streaming";

export interface SseBackpressureLimits {
  /** Writes still waiting on the client before it is cut off. */
  readonly max_pending_writes: number;
  /** How long the oldest waiting write may wait before the client is cut off. */
  readonly stall_ms: number;
}

export const DEFAULT_SSE_LIMITS: SseBackpressureLimits = { max_pending_writes: 1000, stall_ms: 60_000 };

export type GuardableSseStream = Pick<SSEStreamingApi, "writeSSE" | "write" | "abort" | "aborted">;

export interface GuardedSseStream {
  send(message: SSEMessage): Promise<void>;
  sendRaw(text: string): Promise<void>;
  /** Abort when the oldest waiting write has waited past the stall limit. Call on each heartbeat. */
  checkStall(): void;
}

export function guardSseStream(
  stream: GuardableSseStream,
  limits: SseBackpressureLimits = DEFAULT_SSE_LIMITS,
  now: () => number = Date.now,
): GuardedSseStream {
  // Writes settle in the order they were queued, so the head is the oldest.
  const pendingSince: number[] = [];
  const track = async (write: () => Promise<unknown>): Promise<void> => {
    if (stream.aborted) return;
    if (pendingSince.length >= limits.max_pending_writes) {
      stream.abort();
      return;
    }
    pendingSince.push(now());
    try {
      await write();
    } finally {
      pendingSince.shift();
    }
  };
  return {
    send: (message) => track(() => stream.writeSSE(message)),
    sendRaw: (text) => track(() => stream.write(text)),
    checkStall: () => {
      const oldest = pendingSince[0];
      if (oldest !== undefined && now() - oldest >= limits.stall_ms) stream.abort();
    },
  };
}
