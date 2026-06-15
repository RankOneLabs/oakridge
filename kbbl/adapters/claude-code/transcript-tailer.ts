// Transcript tailer — the IO half of the transcript→event bridge.
//
// Watches CC's on-disk JSONL transcript and feeds each newly-appended line
// through the pure `transcriptEntryToEvents` transform, emitting the resulting
// `user`/`assistant`/`result` envelope events into the session. Those events
// are NOT in the adapter's nonPersistedEventTypes set, so they persist to
// kbbl's own JSONL and replay on reconnect (unlike the raw pty_output stream).
//
// All filesystem error handling is contained here (the IO boundary); the
// transform stays pure. See transcript.ts for the mapping rationale.

import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";

import type { Session } from "../../core/session/session";
import { transcriptEntryToEvents } from "./transcript";

const NEWLINE = 0x0a;
// Poll cadence as a fallback for filesystems/platforms where fs.watch misses
// appends. fs.watch (when it fires) drives sub-second latency; the poll is the
// floor that guarantees progress regardless.
const POLL_MS = 750;
// Debounce window so a burst of watch/poll triggers collapses into one drain.
const DEBOUNCE_MS = 30;

export interface TailerHandle {
  dispose: () => void;
}

interface TailerOpts {
  path: string;
  emit: (type: string, payload: unknown) => Promise<unknown>;
  signal: AbortSignal;
  /** Trace label for logs (the oakridge sid). */
  label: string;
}

/**
 * Start tailing a transcript file. Reads incrementally from a byte offset,
 * decodes only up to the last complete newline (so a multi-byte UTF-8
 * character split across reads is never decoded mid-sequence), and routes each
 * complete JSON line through the transform. Stops and releases the watcher
 * when `signal` aborts (session end).
 */
export function startTranscriptTailer(opts: TailerOpts): TailerHandle {
  const { path, emit, signal, label } = opts;

  let offset = 0;
  // Bytes after the last newline of the previous read — a line still being
  // written. Held as raw bytes (not a string) to survive a multi-byte split.
  let leftover = Buffer.alloc(0);
  const seenUuids = new Set<string>();

  let disposed = false;
  let draining = false;
  let drainAgain = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A complete line that isn't valid JSON shouldn't happen (we only
      // decode up to a newline), but never let one poison the stream.
      return;
    }
    const uuid =
      typeof (parsed as { uuid?: unknown }).uuid === "string"
        ? (parsed as { uuid: string }).uuid
        : null;
    if (uuid !== null) {
      if (seenUuids.has(uuid)) return;
      seenUuids.add(uuid);
    }
    for (const evt of transcriptEntryToEvents(parsed)) {
      await emit(evt.type, evt.payload);
    }
  };

  const drainOnce = async (): Promise<void> => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      // File not created yet, or transiently unavailable — try next tick.
      return;
    }
    if (size < offset) {
      // File shrank (rotated/truncated) — restart from the top.
      offset = 0;
      leftover = Buffer.alloc(0);
    }
    if (size === offset) return;

    const length = size - offset;
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    try {
      const fh = await open(path, "r");
      try {
        const res = await fh.read(buf, 0, length, offset);
        bytesRead = res.bytesRead;
      } finally {
        await fh.close();
      }
    } catch (err) {
      console.error(
        `kbbl: transcript read failed [${label}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    offset += bytesRead;

    const combined =
      leftover.length === 0
        ? buf.subarray(0, bytesRead)
        : Buffer.concat([leftover, buf.subarray(0, bytesRead)]);
    const lastNewline = combined.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      // No complete line yet; keep accumulating.
      leftover = combined;
      return;
    }
    const complete = combined.subarray(0, lastNewline).toString("utf8");
    leftover = combined.subarray(lastNewline + 1);

    for (const line of complete.split("\n")) {
      if (disposed) return;
      await processLine(line);
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        await drainOnce();
      } while (drainAgain && !disposed);
    } finally {
      draining = false;
    }
  };

  const scheduleDrain = (): void => {
    if (disposed) return;
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void drain();
    }, DEBOUNCE_MS);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (poll !== null) clearInterval(poll);
    watcher?.close();
    watcher = null;
  };

  if (signal.aborted) {
    // Session already ended before we got here; nothing to tail.
    return { dispose: () => {} };
  }
  signal.addEventListener("abort", dispose, { once: true });

  // fs.watch can throw if the file/dir is missing; the poll covers that case
  // until the file appears, so a failed watch is non-fatal.
  try {
    watcher = watch(path, () => scheduleDrain());
  } catch {
    watcher = null;
  }
  poll = setInterval(() => scheduleDrain(), POLL_MS);

  // Kick once immediately so any lines already written (the tailer can start
  // a touch after CC's first writes) are picked up without waiting a poll.
  scheduleDrain();

  return { dispose };
}

// One tailer per session for this server lifetime. A WeakSet keyed by the
// Session keeps the "already started" flag off the Session's own surface and
// lets it be collected with the session.
const tailing = new WeakSet<Session>();

/**
 * Idempotently start a transcript tailer for `session`. Safe to call from
 * every hook that carries a transcript_path — the first call wins; later calls
 * are no-ops. Disposal is wired to the session's ended signal.
 */
export function ensureTranscriptTailer(
  session: Session,
  transcriptPath: string,
): void {
  if (tailing.has(session)) return;
  tailing.add(session);
  startTranscriptTailer({
    path: transcriptPath,
    emit: (type, payload) => session.emit(type, payload),
    signal: session.endedSignal,
    label: session.oakridgeSid,
  });
}
