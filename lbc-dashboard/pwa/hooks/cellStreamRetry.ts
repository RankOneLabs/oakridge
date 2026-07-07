/**
 * Retry manager for the cell SSE stream.
 *
 * Extracted from useCellEvents so it can be tested without a DOM or
 * React environment. The hook is a thin wrapper that injects real
 * EventSource / setTimeout / requestAnimationFrame and wires React state.
 *
 * Retry logic:
 *   - On error: retry only while the matching run is active.
 *   - Backoff: 500 ms → 1 s → 2 s → 4 s (capped).
 *   - Deadline: stop after DEFAULT_MAX_RETRY_MS total elapsed.
 *   - On successful open: clear error, reset attempt counter.
 *   - On stop(): cancel pending timer, close current EventSource.
 */
import type { CellEvent } from "../lib/types";

export const INITIAL_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 4_000;
export const DEFAULT_MAX_RETRY_MS = 30_000;

export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  close(): void;
}

export interface CellStreamRetryOptions {
  url: string;
  isRunActive: () => boolean;
  onEvent: (evt: CellEvent) => void;
  onConnected: () => void;
  onError: (msg: string) => void;
  createEventSource: (url: string) => EventSourceLike;
  /** Returns a cancel function. */
  scheduleRetry: (fn: () => void, ms: number) => () => void;
  now: () => number;
  maxRetryMs?: number;
}

export interface CellStreamRetry {
  start(): void;
  stop(): void;
}

export function createCellStreamRetry(
  opts: CellStreamRetryOptions,
): CellStreamRetry {
  const {
    url,
    isRunActive,
    onEvent,
    onConnected,
    onError,
    createEventSource,
    scheduleRetry,
    now,
    maxRetryMs = DEFAULT_MAX_RETRY_MS,
  } = opts;

  let stopped = false;
  let currentEs: EventSourceLike | null = null;
  let cancelRetry: (() => void) | null = null;
  let attempt = 0;
  const deadline = now() + maxRetryMs;

  function connect() {
    if (stopped) return;

    const es = createEventSource(url);
    currentEs = es;

    es.addEventListener("message", (ev) => {
      if (stopped) return;
      let evt: CellEvent;
      try {
        evt = JSON.parse(String(ev.data)) as CellEvent;
      } catch {
        return;
      }
      onEvent(evt);
    });

    es.onopen = () => {
      if (stopped) return;
      attempt = 0;
      onConnected();
    };

    es.onerror = () => {
      if (stopped) return;
      es.close();
      currentEs = null;

      if (now() >= deadline) {
        onError(
          "cell stream not available: connection timed out after retries",
        );
        return;
      }

      if (!isRunActive()) {
        onError("cell stream not available: run is no longer active");
        return;
      }

      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt),
        MAX_RETRY_DELAY_MS,
      );
      attempt++;
      cancelRetry = scheduleRetry(connect, delay);
    };
  }

  return {
    start() {
      connect();
    },
    stop() {
      stopped = true;
      cancelRetry?.();
      cancelRetry = null;
      currentEs?.close();
      currentEs = null;
    },
  };
}
