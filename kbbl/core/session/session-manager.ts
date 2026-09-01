import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_ARTIFACT_ID_LENGTH,
  type ArtifactId,
  type ResultUsage,
  type SessionEndReason,
  type SessionSnapshot,
} from "./types";
import { removeWorktree } from "./worktree";
import type { RuntimeId } from "../runtime";

/**
 * Read-only reader over the pre-ACP JSONL session archive.
 *
 * kbbl's session backend cut over to ACP (§21): every live session is now
 * created, driven, and torn down by `AcpSessionService`. This class no
 * longer spawns anything and never holds a live session in memory — it
 * only lists/loads the JSONL transcripts sessions wrote before the
 * cutover, and lets an operator purge one. `SessionManager.get()` always
 * returns `undefined` (nothing ever populates a live-session map any
 * more); it stays as a trivial accessor because a couple of call sites
 * (dispatch-reconciler's legacy-ref fallback, the cohort status route)
 * still probe it defensively for a session ref that predates ACP.
 */

interface JsonObjectPayload {
  readonly [key: string]: unknown;
}

interface ArchivedSessionStartedPayload extends JsonObjectPayload {
  readonly workdir?: unknown;
  readonly name?: unknown;
  readonly runtimeId?: unknown;
  readonly parentCcSid?: unknown;
  readonly parentOakridgeSid?: unknown;
  readonly artifactId?: unknown;
  readonly worktreePath?: unknown;
  readonly worktreeBranch?: unknown;
  readonly worktreeBaseRef?: unknown;
  readonly projectWorkdir?: unknown;
  readonly model?: unknown;
  readonly effort?: unknown;
}

function payloadObject(payload: unknown): JsonObjectPayload {
  return (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as JsonObjectPayload;
}

function archivedSessionStartedPayload(
  payload: unknown,
): ArchivedSessionStartedPayload {
  return payloadObject(payload);
}

/** One line of a session's on-disk JSONL transcript. */
interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

async function readJsonlOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return "";
    }
    throw err;
  }
}

interface ResultPayload {
  usage?: unknown;
}

interface ResultUsagePayload {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

function resultPayload(value: unknown): ResultPayload | null {
  if (typeof value !== "object" || value === null) return null;
  return value;
}

function resultUsagePayload(value: unknown): ResultUsagePayload | null {
  if (typeof value !== "object" || value === null) return null;
  return value;
}

function extractResultUsage(payload: unknown): ResultUsage | null {
  const resultPayloadValue = resultPayload(payload);
  if (!resultPayloadValue) return null;
  const usage = resultUsagePayload(resultPayloadValue.usage);
  if (!usage) return null;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  if (input === null || output === null) return null;
  const result: ResultUsage = {
    input_tokens: input,
    output_tokens: output,
  };
  if (typeof usage.cache_creation_input_tokens === "number") {
    result.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  return result;
}

export interface SessionManagerOpts {
  sessionsDir: string;
}

/**
 * Thrown by SessionManager.remove() when unlinking the JSONL fails for
 * any reason other than ENOENT. The HTTP route handler catches this and
 * returns a 500 so the client doesn't see a misleading "removed"
 * success while the transcript may still be present. ENOENT is
 * intentionally treated as success in remove() and never throws this.
 */
export class RemoveFailedError extends Error {
  readonly sid: string;
  readonly jsonlPath: string;
  // `cause` is on the ES2022 Error base; `override` keeps strict TS happy.
  override readonly cause: unknown;
  constructor(sid: string, jsonlPath: string, cause: unknown) {
    super(
      `failed to unlink ${jsonlPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "RemoveFailedError";
    this.sid = sid;
    this.jsonlPath = jsonlPath;
    this.cause = cause;
  }
}

export class SessionManager {
  private readonly opts: SessionManagerOpts;

  /**
   * Lazy cache of the archived-snapshot scan. Populated on first call to
   * listArchivedSnapshots() and reused thereafter — within a single
   * server run, archived sessions are immutable. Only remove() invalidates
   * an entry.
   *
   * null = not yet loaded; non-null = loaded once, value is authoritative.
   */
  private archivedSnapshotCache: Map<string, SessionSnapshot> | null = null;
  /**
   * Single-flight guard for the initial archived scan. While a scan is in
   * flight this holds the populating promise; concurrent
   * listArchivedSnapshots() callers await the same promise instead of each
   * launching a duplicate readdir+parse pass, and remove() awaits it before
   * mutating the cache so a delete arriving mid-scan can't race with the
   * later cache write and resurrect a purged sid.
   */
  private archivedScanPromise: Promise<void> | null = null;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  /**
   * Always undefined: nothing has spawned a live in-memory session since
   * the ACP cutover. Kept as a trivial accessor for the couple of call
   * sites (dispatch-reconciler, cohort status) that still probe a legacy
   * session ref defensively before falling through to their ACP path.
   * Typed as `SessionSnapshot | undefined` (rather than a bare `undefined`
   * literal) so those call sites can keep reading `.status` off the
   * result without every reference collapsing to `never`.
   */
  get(_oakridgeSid: string): SessionSnapshot | undefined {
    return undefined;
  }

  /** Always empty: no live in-memory sessions exist post-cutover. */
  listSnapshots(): SessionSnapshot[] {
    return [];
  }

  /** Always empty: no live in-memory sessions exist post-cutover. See
   * listArchivedSnapshots() for the pre-cutover archive. */
  listByArtifact(_artifactId: ArtifactId): SessionSnapshot[] {
    return [];
  }

  /**
   * Returns snapshots reconstructed from every JSONL transcript on disk —
   * i.e. every pre-ACP-cutover session, all necessarily archived (ended).
   *
   * First call scans the sessions directory and parses each JSONL; result
   * is cached for the lifetime of the server process. Subsequent calls
   * return cached snapshots without I/O. Only remove() can invalidate an
   * entry.
   */
  async listArchivedSnapshots(): Promise<SessionSnapshot[]> {
    // Cold path: if the cache hasn't been populated yet, kick off (or
    // join) the single-flight scan. All concurrent callers await the same
    // promise so the readdir+parse pass runs once. We catch rejection
    // here so a transient scan failure surfaces as an empty list rather
    // than a 500 from /sessions?include=archived; the .finally() in the
    // launch site already clears archivedScanPromise so the next call
    // retries the scan from scratch. Logged (not silently swallowed) so
    // a real EACCES/I/O error on sessionsDir is diagnosable in server
    // logs instead of looking like "no archived sessions".
    if (this.archivedSnapshotCache === null) {
      if (this.archivedScanPromise === null) {
        this.archivedScanPromise = this.populateArchivedCache().finally(() => {
          this.archivedScanPromise = null;
        });
      }
      await this.archivedScanPromise.catch((err) => {
        console.error(
          `kbbl: archived snapshot scan failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // Re-read after the (possible) await — populateArchivedCache may have
    // populated the cache, or thrown without populating. In the latter
    // case we return an empty list and the next call will retry.
    const cache: Map<string, SessionSnapshot> | null = this.archivedSnapshotCache;
    if (cache === null) return [];
    return [...cache.values()];
  }

  private async populateArchivedCache(): Promise<void> {
    const cache = new Map<string, SessionSnapshot>();
    let entries: string[];
    try {
      entries = await readdir(this.opts.sessionsDir);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        // Empty cache is still a valid populated state — sessionsDir
        // missing is a normal cold start and shouldn't force a re-scan.
        this.archivedSnapshotCache = cache;
        return;
      }
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.slice(0, -".jsonl".length);
      const jsonlPath = join(this.opts.sessionsDir, name);
      const snap = await loadArchivedSnapshot(sid, jsonlPath);
      if (snap) cache.set(sid, snap);
    }
    this.archivedSnapshotCache = cache;
  }

  /**
   * Hard-deletes an archived session: removes its JSONL from disk and, if
   * it retained a worktree, best-effort cleans that up too. Returns true
   * if anything was removed, false if the sid was unknown. Throws
   * RemoveFailedError if unlink fails for any reason other than ENOENT, so
   * the route handler can return 5xx instead of advertising a successful
   * purge while removal of the transcript could not be confirmed.
   */
  async remove(oakridgeSid: string): Promise<boolean> {
    // Trigger the archived scan up front (if it hasn't run yet and isn't
    // already in flight) and await it before touching the cache — a
    // listArchivedSnapshots() call landing mid-remove could otherwise
    // start a fresh scan that reads the JSONL we're about to unlink and
    // writes it back into the cache after our cache.delete(), resurrecting
    // a purged sid.
    if (this.archivedSnapshotCache === null && this.archivedScanPromise === null) {
      this.archivedScanPromise = this.populateArchivedCache().finally(() => {
        this.archivedScanPromise = null;
      });
    }
    if (this.archivedScanPromise) {
      try {
        await this.archivedScanPromise;
      } catch {
        // Scan failure is the scan's problem; we still want to attempt
        // the remove. If the cache is null after this, the cache eviction
        // step below is a no-op (and a later list call will retry the
        // scan, which won't see this sid because we'll have unlinked it).
      }
    }
    // Snapshot worktree info BEFORE eviction so a retained per-session
    // worktree can still be cleaned up after the JSONL is gone.
    const worktreeInfo = await this.lookupWorktreeForRemove(oakridgeSid);
    const jsonlPath = join(this.opts.sessionsDir, `${oakridgeSid}.jsonl`);
    // Distinct from "unlink resolved without throwing": only true when
    // unlink actually deleted a file (ENOENT does NOT set this).
    let unlinkDeletedFile = false;
    try {
      await unlink(jsonlPath);
      unlinkDeletedFile = true;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : null;
      if (code !== "ENOENT") {
        // Real failure (EACCES, EBUSY, EIO, ...). Do NOT evict from cache.
        throw new RemoveFailedError(oakridgeSid, jsonlPath, err);
      }
      // ENOENT — file was already gone. Resolved without throwing, but
      // we did not actually delete anything; unlinkDeletedFile stays false.
    }
    let removed = unlinkDeletedFile;
    if (this.archivedSnapshotCache?.delete(oakridgeSid)) removed = true;
    // Best-effort worktree cleanup AFTER the JSONL is gone. JSONL is the
    // source of truth — if we removed the worktree first and the unlink
    // then failed, a retry would see a JSONL pointing at a dead worktree.
    if (worktreeInfo !== null) {
      await removeWorktree(worktreeInfo).catch((e) => {
        console.error(
          `kbbl: worktree cleanup during remove(${oakridgeSid}) threw: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
    }
    return removed;
  }

  /**
   * Returns the (workdir, worktreePath, worktreeBranch) tuple needed to
   * shell out `git worktree remove`, or null if the archived session
   * predates per-session worktrees or has none on record.
   */
  private async lookupWorktreeForRemove(
    oakridgeSid: string,
  ): Promise<{ workdir: string; worktreePath: string; worktreeBranch: string } | null> {
    const cached = this.archivedSnapshotCache?.get(oakridgeSid);
    if (cached) {
      if (
        cached.worktreePath === null ||
        cached.worktreeBranch === null ||
        cached.projectWorkdir === null
      ) {
        return null;
      }
      return {
        workdir: cached.projectWorkdir,
        worktreePath: cached.worktreePath,
        worktreeBranch: cached.worktreeBranch,
      };
    }
    const jsonlPath = join(this.opts.sessionsDir, `${oakridgeSid}.jsonl`);
    const snap = await loadArchivedSnapshot(oakridgeSid, jsonlPath);
    if (
      !snap ||
      snap.worktreePath === null ||
      snap.worktreeBranch === null ||
      snap.projectWorkdir === null
    ) {
      return null;
    }
    return {
      workdir: snap.projectWorkdir,
      worktreePath: snap.worktreePath,
      worktreeBranch: snap.worktreeBranch,
    };
  }
}

// Named payload shapes for the observed-model reconstruction branches.
// Each lists only the field(s) the corresponding case reads; values come
// in as `unknown` from JSON.parse so the runtime checks below stay
// authoritative — the types document intent and keep narrowing local to
// each case instead of repeating ad-hoc `(payload as {...})` casts.
type ModelObservedPayload = { model?: unknown };
type SystemInitPayload = { subtype?: unknown; model?: unknown };
type AssistantPayload = { message?: unknown };

/**
 * Reconstructs a SessionSnapshot from an on-disk JSONL transcript. Every
 * archived session is necessarily ended (its process is not in memory —
 * either it exited cleanly and wrote no further events, or the server
 * restarted). Returns null if the file is empty, missing, or unreadable,
 * since an empty jsonl can't yield a useful row and a single unreadable
 * jsonl shouldn't fail the whole archived-list response.
 */
async function loadArchivedSnapshot(
  sid: string,
  jsonlPath: string,
): Promise<SessionSnapshot | null> {
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    // readJsonlOrEmpty swallows ENOENT but rethrows everything else (e.g.
    // EACCES, EISDIR, I/O errors). Skip the entry rather than 500 the
    // caller — the admin can chase it in logs.
    console.error(
      `kbbl: failed to read archived jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!contents) return null;
  let createdAt: string | null = null;
  let workdir = "";
  let name = "";
  let runtimeId: RuntimeId = "claude-code";
  // Always null: reconstructing a runtime-internal session id from JSONL
  // required an AgentRuntime.reconstructSnapshot() adapter call, which the
  // manager never wired (no registry is passed at construction) even
  // before the runtime-registry machinery was deleted — so this was
  // already dead in production. Kept as an explicit field (not inlined)
  // so the SessionSnapshot shape below stays self-documenting.
  const ccSid: string | null = null;
  let parentCcSid: string | null = null;
  let parentOakridgeSid: string | null = null;
  let artifactId: ArtifactId | null = null;
  let lastActivityTs = "";
  const allowedTools = new Set<string>();
  let yoloMode = false;
  let lastResultUsage: ResultUsage | null = null;
  // Phase 1+ worktree metadata. All four absent = pre-Phase-1 session;
  // present = isolated worktree may still be on disk (or may have been
  // discarded — caller must handle ENOENT on worktreePath).
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  let worktreeBaseRef: string | null = null;
  let projectWorkdir: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  // Reconstructed from `model_observed` envelope events (first-wins for
  // initialObservedModel, last-wins for observedModel), with a back-compat
  // fallback that scans system+init payload.model (first-wins) and
  // assistant payload.message.model (last-wins) for sessions written
  // before `model_observed` existed.
  let observedModel: string | null = null;
  let initialObservedModel: string | null = null;
  let endReason: SessionEndReason | null = null;
  let exitCode: number | null = null;
  let successorSid: string | null = null;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    lastActivityTs = evt.ts;
    const payload = payloadObject(evt.payload);
    switch (evt.type) {
      case "session_started": {
        const sessionStartedPayload = archivedSessionStartedPayload(payload);
        if (createdAt === null) createdAt = evt.ts;
        if (typeof sessionStartedPayload.workdir === "string") {
          workdir = sessionStartedPayload.workdir;
        }
        if (typeof sessionStartedPayload.name === "string") {
          name = sessionStartedPayload.name;
        }
        if (
          sessionStartedPayload.runtimeId === "claude-code" ||
          sessionStartedPayload.runtimeId === "codex"
        ) {
          runtimeId = sessionStartedPayload.runtimeId;
        }
        if (typeof sessionStartedPayload.parentCcSid === "string") {
          parentCcSid = sessionStartedPayload.parentCcSid;
        }
        if (typeof sessionStartedPayload.parentOakridgeSid === "string") {
          parentOakridgeSid = sessionStartedPayload.parentOakridgeSid;
        }
        if (typeof sessionStartedPayload.artifactId === "string") {
          // Mirror POST /sessions validation: trim, ignore empty, and
          // ignore over-cap so malformed/legacy JSONL can't yield
          // artifactId: "" or an unbounded tag in archived snapshots.
          const trimmed = sessionStartedPayload.artifactId.trim();
          if (trimmed && trimmed.length <= MAX_ARTIFACT_ID_LENGTH) {
            artifactId = trimmed as ArtifactId;
          }
        }
        if (typeof sessionStartedPayload.worktreePath === "string") {
          worktreePath = sessionStartedPayload.worktreePath;
        }
        if (typeof sessionStartedPayload.worktreeBranch === "string") {
          worktreeBranch = sessionStartedPayload.worktreeBranch;
        }
        if (typeof sessionStartedPayload.worktreeBaseRef === "string") {
          worktreeBaseRef = sessionStartedPayload.worktreeBaseRef;
        }
        if (typeof sessionStartedPayload.projectWorkdir === "string") {
          projectWorkdir = sessionStartedPayload.projectWorkdir;
        }
        // No allowlist gate: model is stored as-is from session_started —
        // archived snapshots must faithfully replay whatever was stored,
        // including future model ids and date-suffixed snapshot strings
        // that weren't in any allowlist at write time.
        if (typeof sessionStartedPayload.model === "string") {
          model = sessionStartedPayload.model;
        }
        if (typeof sessionStartedPayload.effort === "string") {
          effort = sessionStartedPayload.effort;
        }
        break;
      }
      case "model_observed": {
        const p = payload as ModelObservedPayload;
        if (typeof p.model === "string") {
          if (initialObservedModel === null) initialObservedModel = p.model;
          observedModel = p.model;
        }
        break;
      }
      case "system": {
        // Back-compat: pre-cohort sessions have no `model_observed` events,
        // but the underlying CC payload still carries the value on init.
        const p = payload as SystemInitPayload;
        if (observedModel === null && p.subtype === "init") {
          if (typeof p.model === "string") {
            if (initialObservedModel === null) initialObservedModel = p.model;
            observedModel = p.model;
          }
        }
        break;
      }
      case "assistant": {
        // Back-compat last-wins: an assistant turn under a different model
        // (e.g. a subagent) updates observedModel just as the live path did.
        const p = payload as AssistantPayload;
        if (p.message && typeof p.message === "object") {
          const m = (p.message as { model?: unknown }).model;
          if (typeof m === "string") {
            if (initialObservedModel === null) initialObservedModel = m;
            observedModel = m;
          }
        }
        break;
      }
      case "tool_allowlisted": {
        if (typeof payload.tool_name === "string") {
          allowedTools.add(payload.tool_name);
        }
        break;
      }
      case "yolo_mode_changed": {
        if (typeof payload.enabled === "boolean") yoloMode = payload.enabled;
        break;
      }
      case "result": {
        const usage = extractResultUsage(payload);
        if (usage) lastResultUsage = usage;
        break;
      }
      case "compact_completed": {
        // Only the success path (successor_sid is a string) marks this as a
        // terminal compaction. Resume-failed paths emit successor_sid: null
        // and keep the old session live, so a later event (subprocess_exited)
        // decides the true endReason.
        if (typeof payload.successor_sid === "string") {
          endReason = "compacted";
          successorSid = payload.successor_sid;
        }
        break;
      }
      case "subprocess_exited": {
        // Only set when no terminal reason has already been resolved by an
        // earlier compact_completed.
        if (endReason === null) endReason = "subprocess_exited";
        if (typeof payload.code === "number") exitCode = payload.code;
        break;
      }
    }
  }
  if (!createdAt) return null;
  return {
    sid,
    name: name || `session-${sid.slice(0, 8)}`,
    workdir,
    // The file is on disk and not in memory, so by definition the session
    // is no longer running.
    status: "ended",
    createdAt,
    lastActivityTs: lastActivityTs || createdAt,
    runtimeId,
    runtimeSid: ccSid,
    ccSid: runtimeId === "claude-code" ? ccSid : null,
    parentCcSid,
    parentOakridgeSid,
    artifactId,
    pendingCount: 0,
    yoloMode,
    allowedTools: [...allowedTools],
    lastResultUsage,
    worktreePath,
    worktreeBranch,
    worktreeBaseRef,
    projectWorkdir,
    model,
    effort,
    initialObservedModel,
    observedModel,
    endReason,
    exitCode,
    successorSid,
  };
}
