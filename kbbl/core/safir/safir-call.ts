// Caller-side wrapper for kbbl→safir requests. Lets a call site write
//
//   const created = await safirCall(ctx, () => client.createRun(...), { ... });
//
// without sprinkling try/catch + queue.enqueue at every consumer. Returns
// null on transient failure (5xx + network) after enqueueing the fallback;
// throws on 4xx since those represent real bugs and should surface to the
// caller, not get swallowed into the queue where they'd be auto-dropped.

import { SafirHttpError } from "./client";
import type { QueueRequest, SafirQueue } from "./queue";

export interface SafirCallContext {
  queue: SafirQueue;
  logger?: { warn: (m: string) => void };
}

export async function safirCall<T>(
  ctx: SafirCallContext,
  fn: () => Promise<T>,
  fallback: QueueRequest,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SafirHttpError && err.status >= 500) {
      await ctx.queue.enqueue(fallback);
      ctx.logger?.warn(
        `safir 5xx queued: ${fallback.method} ${fallback.path}`,
      );
      return null;
    }
    // fetch surfaces network failures as TypeError; AbortController.abort()
    // (timeout path in client.ts) surfaces as a DOMException with name
    // "AbortError" in both Node's undici and Bun. Treat both as transient.
    const isAbortError = err instanceof Error && err.name === "AbortError";
    if (err instanceof TypeError || isAbortError) {
      await ctx.queue.enqueue(fallback);
      ctx.logger?.warn(
        `safir network error queued: ${fallback.method} ${fallback.path}`,
      );
      return null;
    }
    throw err;
  }
}
