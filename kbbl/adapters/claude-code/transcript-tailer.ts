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
import { classifyCcEvent } from "./event-classifier";
import { transcriptEntryToEvents } from "./transcript";

const NEWLINE = 0x0a;
// Poll cadence as a fallback for filesystems/platforms where fs.watch misses
// appends. fs.watch (when it fires) drives sub-second latency; the poll is the
// floor that guarantees progress regardless.
const POLL_MS = 750;
// Debounce window so a burst of watch/poll triggers collapses into one drain.
const DEBOUNCE_MS = 30;
// Upper bound on a single read allocation. A long session's transcript can
// reach many MB; on the backlog catch-up path (attach with offset 0, or a
// post-truncation reset) the whole tail would otherwise be read into one
// Buffer.alloc, spiking memory. We read in fixed-size chunks instead and carry
// any trailing partial line across chunk boundaries via `leftover`.
const MAX_READ_CHUNK = 64 * 1024;

export interface TailerHandle {
  dispose: () => void;
  /**
   * Force a drain right now and await it to quiescence. If a drain is already
   * in flight, chains on the same promise so the caller sees the full settled
   * state — never returns early. Used by the Stop hook handler to flush any
   * end_turn line CC just wrote before deciding whether to synthesize a result.
   */
  drainNow: () => Promise<void>;
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
  // Tracks the active drain promise so drainNow can chain on it rather than
  // returning early when a drain is already in flight.
  let drainPromise: Promise<void> | null = null;

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
      if (disposed) return;
      // drain() is fired with `void drain()` (scheduleDrain), so a rejected
      // emit would surface as an unhandled rejection AND halt forward
      // processing of the remaining events. Contain it here: log and continue,
      // so one transient emit failure (disk error, emitQueue hiccup) can't
      // stall the tailer for the rest of the session.
      try {
        await emit(evt.type, evt.payload);
      } catch (err) {
        console.error(
          `kbbl: transcript emit failed [${label}] type=${evt.type}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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

    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(path, "r");
    } catch (err) {
      console.error(
        `kbbl: transcript open failed [${label}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    try {
      // Read the backlog (offset → the size snapshot taken above) in bounded
      // chunks; appends past `size` are picked up by the next scheduled drain.
      // A line that straddles a chunk boundary stays in `leftover` until a
      // newline arrives in a later chunk, so multi-byte UTF-8 and long lines
      // are never decoded mid-sequence.
      while (offset < size && !disposed) {
        const length = Math.min(size - offset, MAX_READ_CHUNK);
        const buf = Buffer.alloc(length);
        let bytesRead = 0;
        try {
          const res = await fh.read(buf, 0, length, offset);
          bytesRead = res.bytesRead;
        } catch (err) {
          console.error(
            `kbbl: transcript read failed [${label}]: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return;
        }
        // Defensive: a 0-byte read with bytes still expected would spin.
        if (bytesRead === 0) break;
        offset += bytesRead;

        const combined =
          leftover.length === 0
            ? buf.subarray(0, bytesRead)
            : Buffer.concat([leftover, buf.subarray(0, bytesRead)]);
        const lastNewline = combined.lastIndexOf(NEWLINE);
        if (lastNewline === -1) {
          // No complete line in this chunk yet; carry it and read more.
          leftover = combined;
          continue;
        }
        const complete = combined.subarray(0, lastNewline).toString("utf8");
        leftover = combined.subarray(lastNewline + 1);

        for (const line of complete.split("\n")) {
          if (disposed) return;
          await processLine(line);
        }
      }
    } finally {
      // Contain a close() failure: drainOnce runs under `void drain()`, so a
      // rejection here would surface as an unhandled rejection rather than
      // being observed anywhere. Log and move on, mirroring the read/open
      // error handling above.
      try {
        await fh.close();
      } catch (err) {
        console.error(
          `kbbl: transcript close failed [${label}]: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  const drain = (): Promise<void> => {
    if (draining) {
      // A drain is in flight. Set drainAgain so the loop iterates at least
      // once more (picks up content written after the current drainOnce
      // started). Return the running promise so callers (drainNow) can
      // await quiescence rather than returning early.
      drainAgain = true;
      return drainPromise ?? Promise.resolve();
    }
    draining = true;
    const p = (async () => {
      try {
        do {
          drainAgain = false;
          await drainOnce();
        } while (drainAgain && !disposed);
      } finally {
        draining = false;
        drainPromise = null;
      }
    })();
    drainPromise = p;
    return p;
  };

  const scheduleDrain = (): void => {
    if (disposed) return;
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void drain();
    }, DEBOUNCE_MS);
  };

  const drainNow = (): Promise<void> => {
    // Cancel any pending debounce so we drain immediately, not after the
    // debounce window.
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return drain();
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
    return { dispose: () => {}, drainNow: () => Promise.resolve() };
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

  return { dispose, drainNow };
}

// One tailer per session for this server lifetime. WeakMap keyed by Session so
// the handle can be retrieved for drainNow() calls, and so both map and handle
// are collected when the session is GC'd.
const tailing = new WeakMap<Session, TailerHandle>();

/**
 * Idempotently start a transcript tailer for `session`. Safe to call from
 * every hook that carries a transcript_path — the first call wins; later calls
 * are no-ops. Disposal is wired to the session's ended signal.
 *
 * @param onEventClassified - Optional callback invoked after each event is
 *   emitted and classified. Used by the CC adapter to update its per-session
 *   turn tracker (resultedThisTurn, lastAssistantUsage) without pulling the
 *   tracker into this module.
 */
export function ensureTranscriptTailer(
  session: Session,
  transcriptPath: string,
  onEventClassified?: (type: string, payload: unknown) => void,
): void {
  if (tailing.has(session)) return;
  const handle = startTranscriptTailer({
    path: transcriptPath,
    emit: async (type, payload) => {
      const record = await session.emit(type, payload);
      // Mirror the legacy stdout path: after emit, run the CC classifier so
      // the runtime-observed side effects still fire in PTY mode (where there
      // is no stdout stream-json to classify). It updates observedModel from
      // assistant payloads and, from the synthesized end_turn result payload
      // (which now carries stop_reason + usage), drives observeTurnEnd —
      // lastResultUsage, the usage_observation ring, compactor scheduling.
      //
      // Classification runs in its own try/catch so emit success isn't coupled
      // to it: the line's uuid is already marked seen, so a classifier throw
      // (e.g. a JSONL write failure inside observeTurnEnd) must not bubble up
      // as an "emit failed" and silently strand the observation. Same
      // separate-catch contract as the runtime stdout pump (session.ts).
      try {
        await classifyCcEvent(payload, session);
      } catch (err) {
        console.error(
          `kbbl: transcript classifier failed [${session.oakridgeSid}]: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (onEventClassified) {
        try {
          onEventClassified(type, payload);
        } catch (err) {
          console.error(
            `kbbl: turn tracker update failed [${session.oakridgeSid}]: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return record;
    },
    signal: session.endedSignal,
    label: session.oakridgeSid,
  });
  tailing.set(session, handle);
  // Delete the entry when the session ends so the tailer's captured state
  // (seenUuids, leftover) can be GC'd even though SessionManager holds the
  // Session object for the server lifetime.
  session.endedSignal.addEventListener("abort", () => {
    tailing.delete(session);
  }, { once: true });
}

/**
 * Force-drain the transcript tailer for `session` and await quiescence.
 * Called by the Stop hook handler before deciding whether to synthesize a
 * result, so any end_turn line CC just wrote is processed first. Resolves
 * immediately if no tailer is registered (session may have ended).
 */
export async function drainTranscript(session: Session): Promise<void> {
  const handle = tailing.get(session);
  if (!handle) return;
  await handle.drainNow();
}
