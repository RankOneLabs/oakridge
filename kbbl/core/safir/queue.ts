// Pending-write queue for safir requests that failed transiently. JSONL on
// disk so it survives restart; rewrites happen via temp+rename so a crash
// mid-rewrite can't leave a half-line. The append path (enqueue) is *not*
// crash-safe in the same way: a process/host crash mid-appendFile can
// leave a truncated trailing line, which readAll will skip and log. We
// accept that trade-off — making enqueue go through read+rewrite would
// turn every transient failure into an O(file) write, and the operator-
// visible warning is enough for a rare crash window. Read patterns are
// O(file): the queue is expected to stay small (transient failures only
// — 4xx are dropped at the worker, 2xx never enter), so we re-parse on
// every readPending rather than maintaining an in-memory index that
// would have to stay coherent with the file across crash recovery.

import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 30 * 60;

export type QueueRequest = {
  method: "POST" | "PATCH";
  path: string;
  body: unknown;
};

export type QueueEntry = {
  id: string;
  enqueued_at: string;
  attempts: number;
  next_attempt_at: string;
  request: QueueRequest;
  last_error?: string;
  delivered_at?: string;
};

export interface SafirQueue {
  enqueue(req: QueueRequest): Promise<string>;
  /**
   * Entries with !delivered_at && next_attempt_at <= now. The queue itself
   * does not gate on attempt count; the worker enforces the 5-strike cap
   * (so an operator can manually reset the count by editing the JSONL if
   * they need to retry a stuck entry).
   */
  readPending(now: Date): Promise<QueueEntry[]>;
  recordSuccess(id: string): Promise<void>;
  recordFailure(id: string, error: string, now: Date): Promise<void>;
  /** Rewrites the file empty if every entry has delivered_at set. Cheap no-op otherwise. */
  compactIfAllDelivered(): Promise<void>;
}

export interface CreateSafirQueueOpts {
  dataDir: string;
  logger?: { warn: (m: string) => void };
}

export function createSafirQueue(opts: CreateSafirQueueOpts): SafirQueue {
  const path = join(opts.dataDir, "safir-queue.jsonl");
  const log = opts.logger ?? { warn: (m: string) => console.error(m) };

  // Serialize mutations so an enqueue's appendFile can't race with a
  // recordSuccess/recordFailure/compact rewrite (which would replace the
  // file via rename and silently drop the appended line). Reads stay
  // lock-free — readPending only opens the file for read.
  let mutationChain: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = mutationChain.then(op, op);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function readAll(): Promise<QueueEntry[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
    const out: QueueEntry[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as QueueEntry);
      } catch {
        // Malformed line — skip. Likely a crash truncated the trailing
        // append; log so an operator notices the dropped retry.
        log.warn(
          `safir queue: discarding malformed line ${i + 1} in ${path} (${line.length} bytes)`,
        );
      }
    }
    return out;
  }

  async function rewriteAll(entries: QueueEntry[]): Promise<void> {
    const tmp = `${path}.tmp`;
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    // Trailing newline only when there are entries — keeps the empty-state
    // file zero bytes so a `wc -l` is unambiguous.
    await writeFile(tmp, body.length === 0 ? "" : `${body}\n`);
    await rename(tmp, path);
  }

  function backoffSeconds(attempts: number): number {
    const expSeconds = Math.pow(2, attempts) * BACKOFF_BASE_SECONDS;
    return Math.min(expSeconds, BACKOFF_CAP_SECONDS);
  }

  return {
    enqueue(req) {
      return runExclusive(async () => {
        const id = randomUUID();
        const nowIso = new Date().toISOString();
        const entry: QueueEntry = {
          id,
          enqueued_at: nowIso,
          attempts: 0,
          next_attempt_at: nowIso,
          request: req,
        };
        await appendFile(path, `${JSON.stringify(entry)}\n`);
        return id;
      });
    },

    async readPending(now) {
      const entries = await readAll();
      return entries.filter(
        (e) => !e.delivered_at && new Date(e.next_attempt_at) <= now,
      );
    },

    recordSuccess(id) {
      return runExclusive(async () => {
        const entries = await readAll();
        const next: QueueEntry[] = [];
        for (const e of entries) {
          if (e.id === id) {
            next.push({ ...e, delivered_at: new Date().toISOString() });
          } else {
            next.push(e);
          }
        }
        await rewriteAll(next);
      });
    },

    recordFailure(id, error, now) {
      return runExclusive(async () => {
        const entries = await readAll();
        const next: QueueEntry[] = [];
        for (const e of entries) {
          if (e.id === id) {
            const attempts = e.attempts + 1;
            const nextAttemptMs =
              now.getTime() + backoffSeconds(attempts) * 1000;
            next.push({
              ...e,
              attempts,
              next_attempt_at: new Date(nextAttemptMs).toISOString(),
              last_error: error,
            });
          } else {
            next.push(e);
          }
        }
        await rewriteAll(next);
      });
    },

    compactIfAllDelivered() {
      return runExclusive(async () => {
        const entries = await readAll();
        if (entries.length === 0) return;
        if (entries.every((e) => e.delivered_at)) {
          await rewriteAll([]);
        }
      });
    },
  };
}
