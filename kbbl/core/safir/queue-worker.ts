// Periodic drain of the safir queue. Replays each pending entry against the
// SafirClient, recording success/failure back into the queue. The worker
// owns the 5-strike retry cap (queue.ts is dumb storage); after that the
// entry sits in the JSONL with delivered_at: null forever, visible to an
// operator who can manually edit the file to retry. 4xx replays are
// classified as success-with-warning at this layer — they will never
// transition to 2xx, so leaving them in the queue would cause permanent
// bloat. The clear log line tells the operator something went wrong.

import {
  SafirHttpError,
  type SafirClient,
} from "./client";
import type { QueueEntry, QueueRequest, SafirQueue } from "./queue";

const MAX_ATTEMPTS = 5;

export interface SafirQueueWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface CreateSafirQueueWorkerOpts {
  queue: SafirQueue;
  client: SafirClient;
  /** Drain interval in seconds; from config.safir.queue_drain_interval_seconds. */
  intervalSeconds: number;
  /** Test seam for time. Defaults to () => new Date(). */
  now?: () => Date;
  logger?: { info: (m: string) => void; error: (m: string) => void };
}

export function createSafirQueueWorker(
  opts: CreateSafirQueueWorkerOpts,
): SafirQueueWorker {
  const log = opts.logger ?? {
    info: (m: string) => console.error(m),
    error: (m: string) => console.error(m),
  };
  const now = opts.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    let pending: QueueEntry[];
    try {
      pending = await opts.queue.readPending(now());
    } catch (err) {
      log.error(
        `safir queue: readPending failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    for (const entry of pending) {
      if (entry.attempts >= MAX_ATTEMPTS) continue;
      try {
        await dispatch(opts.client, entry.request);
        await opts.queue.recordSuccess(entry.id);
      } catch (err) {
        if (err instanceof SafirHttpError && err.status >= 400 && err.status < 500) {
          // 4xx is permanent — replays will never succeed. Drop the entry
          // (recordSuccess) but log loud so the operator notices the
          // underlying request was malformed.
          log.error(
            `safir queue: dropping ${entry.request.method} ${entry.request.path}: 4xx ${err.status} ${stringifyBody(err.body)}`,
          );
          await opts.queue.recordSuccess(entry.id);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        await opts.queue.recordFailure(entry.id, msg, now());
      }
    }

    try {
      await opts.queue.compactIfAllDelivered();
    } catch (err) {
      log.error(
        `safir queue: compact failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        // Chain ticks so a slow drain can't overlap with the next interval —
        // queue.ts isn't safe under concurrent rewriteAll. The chain swallows
        // errors so one bad tick doesn't kill the worker.
        running = running
          .then(() => tick())
          .catch((err) => {
            log.error(
              `safir queue: tick threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }, opts.intervalSeconds * 1000);
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await running.catch(() => undefined);
    },
  };
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// Path → client-method dispatcher. Exported for the worker's table-driven
// replay; only the routes lifecycle code actually enqueues are wired here.
// Any other path is a bug (operator-injected entry?) — log + drop at the
// caller via recordSuccess so it can't loop forever.
export async function dispatch(
  client: SafirClient,
  req: QueueRequest,
): Promise<unknown> {
  const m = matchRoute(req.method, req.path);
  if (!m) {
    throw new SafirHttpError(
      400,
      { error: `unknown queue path: ${req.method} ${req.path}` },
      `unknown queue path: ${req.method} ${req.path}`,
    );
  }
  switch (m.kind) {
    case "createRun":
      return client.createRun(m.taskId, req.body as Parameters<SafirClient["createRun"]>[1]);
    case "updateRun":
      return client.updateRun(m.runId, req.body as Parameters<SafirClient["updateRun"]>[1]);
    case "createPhase":
      return client.createPhase(m.runId, req.body as Parameters<SafirClient["createPhase"]>[1]);
    case "updatePhase":
      return client.updatePhase(m.phaseId, req.body as Parameters<SafirClient["updatePhase"]>[1]);
    case "submitHandoff":
      return client.submitHandoff(m.phaseId, req.body as Parameters<SafirClient["submitHandoff"]>[1]);
  }
}

type Match =
  | { kind: "createRun"; taskId: number }
  | { kind: "updateRun"; runId: string }
  | { kind: "createPhase"; runId: string }
  | { kind: "updatePhase"; phaseId: string }
  | { kind: "submitHandoff"; phaseId: string };

function matchRoute(method: string, path: string): Match | null {
  if (method === "POST") {
    let m = /^\/tasks\/(\d+)\/runs$/.exec(path);
    if (m) return { kind: "createRun", taskId: Number.parseInt(m[1]!, 10) };
    m = /^\/runs\/([^/]+)\/phases$/.exec(path);
    if (m) return { kind: "createPhase", runId: m[1]! };
    m = /^\/phases\/([^/]+)\/handoff$/.exec(path);
    if (m) return { kind: "submitHandoff", phaseId: m[1]! };
  }
  if (method === "PATCH") {
    let m = /^\/runs\/([^/]+)$/.exec(path);
    if (m) return { kind: "updateRun", runId: m[1]! };
    m = /^\/phases\/([^/]+)$/.exec(path);
    if (m) return { kind: "updatePhase", phaseId: m[1]! };
  }
  return null;
}
