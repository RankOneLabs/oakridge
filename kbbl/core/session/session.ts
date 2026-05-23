import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Compactor } from "./compactor";
import type { PermissionProfile } from "../safir/types";

export type SessionId = string & { readonly __brand: "SessionId" };

export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

export type Subscriber = (evt: EnvelopeEvent) => void;

export type Decision = "allow" | "deny";

export interface PendingApproval {
  resolve: (d: Decision) => void;
  toolName: string;
}

export interface SpawnCmd {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SessionCallbacks {
  onCcSidObserved?: (session: Session, ccSid: string) => void;
  onEnded?: (session: Session) => void;
  onEmit?: (session: Session, evt: EnvelopeEvent) => void;
  onStatusChanged?: (session: Session, status: SessionStatus) => void;
  onPendingCountChanged?: (session: Session, count: number) => void;
  onLastActivityChanged?: (session: Session, ts: string) => void;
  onYoloChanged?: (session: Session, yoloMode: boolean) => void;
}

export interface SessionOpts {
  oakridgeSid: string;
  /**
   * Spawn cwd. With per-session worktrees on, this is the worktree path
   * (`<dataDir>/worktrees/<sid>`) and `projectWorkdir` carries the operator's
   * original repo. With worktrees off, both are the operator workdir. Every
   * downstream consumer (spawn cwd, JSONL session_started.workdir, snapshot
   * label) reads `workdir` and gets the right thing — there is no separate
   * "spawn cwd" field by design.
   */
  workdir: string;
  name: string;
  sessionsDir: string;
  parentCcSid?: string;
  parentOakridgeSid?: string;
  /**
   * Opaque identifier from legit-biz-club tagging this session as part of
   * an artifact-scoped ensemble. kbbl doesn't model the artifact itself —
   * the id is passed through to snapshots and queryable via
   * SessionManager.listByArtifact() for grouping in the operator UI.
   */
  artifactId?: string;
  /**
   * Per-session runtime model id (e.g., "claude-sonnet-4-6"). null means
   * "no --model flag at spawn" — CC will pick its own default. Persisted
   * into session_started.payload.model so resume-from-disk can recover it.
   * Adapter-specific opaque string; codex sessions will use a different
   * namespace.
   */
  model?: string | null;
  /**
   * Per-session git worktree metadata. All four are null when worktrees are
   * off (or when the operator workdir isn't a git repo). When set,
   * `workdir` above equals `worktreePath` and `projectWorkdir` is the
   * operator's original repo — the dual-label PWA rendering reads both.
   */
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  worktreeBaseRef?: string | null;
  projectWorkdir?: string | null;
  taskId?: number;
  runId?: string;
  permissionProfile?: PermissionProfile | null;
  phaseId?: string;
  callbacks?: SessionCallbacks;
  /**
   * Optional runtime-adapter classifier called for each parsed stdout event
   * after core has emitted it. The adapter inspects events and may update
   * Session metadata (observeRuntimeSessionId, observeTurnEnd) or emit
   * follow-on events. Errors are caught + logged; the pump survives.
   */
  classifyEvent?: (rawEvent: unknown, session: Session) => Promise<void>;
  /**
   * Event types whose emit() calls fan out to subscribers and run the
   * classifier but skip the JSONL writer. CC's --include-partial-messages
   * `stream_event` records are the motivating case — high volume, the final
   * `assistant` event is the canonical record, persisting them would bloat
   * the transcript and slow `/events` replay.
   */
  nonPersistedEventTypes?: ReadonlySet<string>;
}

export type SessionStatus = "starting" | "live" | "compacting" | "ended";

export type SessionEndReason = "user_closed" | "subprocess_exited" | "compacted";

/**
 * Hard cap on `artifactId` length. Enforced at the Session constructor,
 * the POST /sessions handler, the GET /artifacts/:artifactId/sessions
 * handler, and the archived-snapshot reconstruction so the invariant
 * holds at every entry point. Bounds the bytes that ride on every
 * JSONL session_started record and every session_created SSE delta;
 * 200 is generous for any reasonable id scheme (UUIDs, slugs, hashes).
 */
export const MAX_ARTIFACT_ID_LENGTH = 200;

/**
 * Subset of CC's `result`-event usage block. Captured on every `result`
 * emit and snapshotted so the PWA can show a rough token footprint on
 * the Resume button — important on Claude Max where a resume re-ingests
 * parent context and burns against the 5-hour rate-limit window.
 */
export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Per-turn usage observation. Fed into the cache-vs-idle diagnostic — the
 * 5-minute Anthropic prompt cache TTL means cache hit ratio collapses past
 * ~300s of inter-turn idle, and this is the data point the histogram
 * buckets on. `seconds_since_prev_turn` for the first turn is measured
 * from session creation (cold-start latency), so consumers that want a
 * "between-turn" view should filter on `turn_seq > 1`.
 */
export interface UsageObservation {
  turn_seq: number;
  seconds_since_prev_turn: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string | null;
}

/** Bound on per-session in-memory usage history. */
export const USAGE_OBSERVATION_BUFFER_CAPACITY = 200;

export interface SessionSnapshot {
  sid: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityTs: string;
  ccSid: string | null;
  parentCcSid: string | null;
  parentOakridgeSid: string | null;
  /**
   * Tag from legit-biz-club identifying the artifact this session is
   * working on. null for ad-hoc sessions created outside the workspace
   * layer (the existing kbbl-direct flow). Surfaces to the PWA so
   * approvals can be rendered with artifact context.
   */
  artifactId: string | null;
  pendingCount: number;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: ResultUsage | null;
  /**
   * Per-session worktree metadata, all null when worktrees are off (or
   * the operator workdir isn't a repo, or the session predates Phase 1).
   * `workdir` above is the spawn cwd (= worktreePath when set);
   * `projectWorkdir` is the operator's original repo so the PWA can show
   * "this session is editing <project> on branch <kbbl/sid>".
   */
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  projectWorkdir: string | null;
  /**
   * Runtime model id this session was spawned with, or null for sessions
   * created before this field existed / spawned with no override.
   */
  model: string | null;
  /**
   * Reason this session ended, or null if the reason is unknown (session is
   * still live/starting/compacting, or ended without an explicit reason being
   * recorded — e.g. reconstructed from JSONL without a terminal event).
   * "compacted" means runCompact handed off to a successor (paired with
   * `successorSid`); "user_closed" is a deliberate operator close;
   * "subprocess_exited" is a CC subprocess death we did not initiate. The
   * tri-state distinction lets the PWA pick CompactedBanner vs EndedBanner.
   */
  endReason: SessionEndReason | null;
  /**
   * oakridgeSid of the successor session created by runCompact, or null
   * if this session was not compacted (or compaction failed before the
   * successor spawned). Set even when status is still "compacting" the
   * brief gap between successor.spawn() and oldSession.abort(); the PWA
   * uses it to render the "→ session NNN" link as soon as the live snapshot
   * gains it.
   */
  successorSid: string | null;
}

export async function readJsonlOrEmpty(path: string): Promise<string> {
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

export class Session {
  readonly oakridgeSid: SessionId;
  readonly workdir: string;
  readonly name: string;
  readonly jsonlPath: string;
  readonly parentCcSid: string | null;
  readonly parentOakridgeSid: string | null;
  readonly artifactId: string | null;
  readonly createdAt: string;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly worktreeBaseRef: string | null;
  readonly projectWorkdir: string | null;
  readonly model: string | null;

  private _taskId: number | undefined;
  private _runId: string | undefined;
  private _phaseId: string | undefined;
  private _permissionProfile: PermissionProfile | null;
  private _endReason: SessionEndReason | undefined;
  private _successorSid: string | null = null;
  private _compactor: Compactor | null = null;

  private readonly callbacks: SessionCallbacks;
  private readonly classifyEvent?: (
    rawEvent: unknown,
    session: Session,
  ) => Promise<void>;
  private readonly nonPersistedEventTypes: ReadonlySet<string>;
  private readonly jsonlWriter: import("bun").FileSink;
  private nextId = 0;
  private subscribers = new Set<Subscriber>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private inputQueue: Promise<unknown> = Promise.resolve();
  // Serialize write+flush+fanout for every emit so concurrent callers
  // (stdout pump, stderr pump, /hook/approval, /yolo, etc.) can't race on
  // jsonlWriter.flush() resolution order and deliver subscriber frames
  // out of id sequence — SSE's sentUpTo dedup would permanently drop the
  // one that lost the race.
  private emitQueue: Promise<unknown> = Promise.resolve();
  private pendingFlushCount = 0;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  // Independent of emitQueue so disk I/O never blocks the stdout pump.
  private flushQueue: Promise<void> = Promise.resolve();
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private ccSid: string | null = null;
  private _status: SessionStatus = "starting";
  private shutdownSignalReceived = false;
  private lastActivityTs: string;
  private yoloMode = false;
  private allowedTools = new Set<string>();
  private lastResultUsage: ResultUsage | null = null;
  // Wall-clock of the most recent observed turn end. Initialized to
  // createdAt so the first turn's seconds_since_prev_turn is the cold-start
  // gap (user opens session → first reply lands), which is real signal for
  // the cache-vs-idle bucketing.
  private lastResultTs: string;
  private turnSeq = 0;
  private usageObservations: UsageObservation[] = [];
  private exitPromise: Promise<number> | null = null;
  // Tracks the in-flight spawn so an abort() that arrives during the
  // starting window (between manager.sessions.set() and spawn() finishing
  // wiring the pumps + exitPromise) can wait for wiring to complete
  // instead of racing finalize() against still-running spawn code.
  private _spawnPromise: Promise<void> | null = null;
  // Aborts when finalize() runs so long-lived consumers (SSE streams,
  // subscribers) can exit their loops instead of hanging on a dead session.
  private readonly endedController = new AbortController();

  constructor(opts: SessionOpts) {
    this.oakridgeSid = opts.oakridgeSid as SessionId;
    this.workdir = opts.workdir;
    this.name = opts.name;
    this.jsonlPath = join(opts.sessionsDir, `${opts.oakridgeSid}.jsonl`);
    this.parentCcSid = opts.parentCcSid ?? null;
    this.parentOakridgeSid = opts.parentOakridgeSid ?? null;
    // Normalize at the constructor so direct SessionManager.create()
    // callers can't sneak in empty/whitespace or oversized tags even
    // though the HTTP route rejects them. JSONL session_started and
    // snapshots will never contain a malformed artifactId regardless
    // of call site.
    const trimmedArtifactId = opts.artifactId?.trim() || null;
    if (trimmedArtifactId !== null && trimmedArtifactId.length > MAX_ARTIFACT_ID_LENGTH) {
      throw new Error(
        `artifactId must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming (got ${trimmedArtifactId.length})`,
      );
    }
    this.artifactId = trimmedArtifactId;
    this.worktreePath = opts.worktreePath ?? null;
    this.worktreeBranch = opts.worktreeBranch ?? null;
    this.worktreeBaseRef = opts.worktreeBaseRef ?? null;
    this.projectWorkdir = opts.projectWorkdir ?? null;
    this.model = opts.model ?? null;
    this._taskId = opts.taskId;
    this._runId = opts.runId;
    this._phaseId = opts.phaseId;
    this._permissionProfile = opts.permissionProfile ?? null;
    this.createdAt = new Date().toISOString();
    this.lastActivityTs = this.createdAt;
    this.lastResultTs = this.createdAt;
    this.callbacks = opts.callbacks ?? {};
    this.classifyEvent = opts.classifyEvent;
    this.nonPersistedEventTypes = opts.nonPersistedEventTypes ?? new Set();
    this.jsonlWriter = Bun.file(this.jsonlPath).writer();
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentCcSid(): string | null {
    return this.ccSid;
  }

  /**
   * Runtime-adapter injection point: called by the classifier when it
   * observes the underlying runtime's internal session id (e.g., CC's
   * system/init event carries its session_id). First-write-wins; later
   * calls are ignored. Emits cc_session_id_observed into JSONL so resume
   * survives a server restart, and notifies the manager via
   * onCcSidObserved so adapter HTTP routes (CC's gate) can map runtime
   * session ids back to this oakridge session.
   *
   * v0 abstraction caveat: the method takes a generic runtime id, but the
   * persisted JSONL event is CC-shaped (`cc_session_id_observed` with key
   * `cc_session_id`). This is deliberate for v0 — the JSONL transcript
   * format is preserved across the adapter extraction so existing on-disk
   * sessions stay readable. When a second adapter ships and the format
   * needs to be neutral, the persisted event names move with the rest of
   * the snapshot-reconstruction logic into adapter-aware code.
   *
   * Emit happens before the ccSid mutation so a flush error doesn't leave
   * us in a half-applied state (ccSid set but no JSONL record + no manager
   * callback). If emit throws, ccSid stays null and a later call can
   * retry. Same pattern as setYolo / allowlistTool.
   */
  async observeRuntimeSessionId(id: string): Promise<void> {
    if (this.ccSid !== null) return;
    await this.emit("cc_session_id_observed", { cc_session_id: id });
    this.ccSid = id;
    try {
      this.callbacks.onCcSidObserved?.(this, id);
    } catch (e) {
      console.error(
        `kbbl: onCcSidObserved callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Runtime-adapter injection point: called by the classifier on each
   * turn-end event (e.g., CC's `result`). Updates `lastResultUsage` for
   * the PWA's Resume cost preview, appends a UsageObservation to the
   * in-memory ring buffer, and emits a `usage_observation` envelope event
   * that lands in the JSONL for retention/rollup. The ring buffer is
   * bounded by USAGE_OBSERVATION_BUFFER_CAPACITY; oldest entries are
   * dropped when full so the buffer is always cheap to scan.
   *
   * v0 abstraction caveat: `ResultUsage` is currently shaped as a subset
   * of CC's `result.usage` block (input_tokens, output_tokens, cache_*).
   * A runtime-neutral usage type would be premature without a second
   * adapter informing what the union should look like; defer until codex
   * or another runtime exposes a different usage shape.
   */
  async observeTurnEnd(input: {
    usage: ResultUsage;
    model: string | null;
  }): Promise<void> {
    const now = new Date();
    const prevMs = Date.parse(this.lastResultTs);
    const seconds_since_prev_turn = (now.getTime() - prevMs) / 1000;

    // Build the observation with the next turn_seq value (turnSeq is not
    // yet incremented). Emit before mutating any state so a JSONL flush
    // failure leaves the session at the prior turn_seq / lastResultTs and
    // a later result event can retry without dropping or duplicating an
    // observation. Same emit-first-then-commit pattern as
    // observeRuntimeSessionId, setYolo, and allowlistTool.
    const observation: UsageObservation = {
      turn_seq: this.turnSeq + 1,
      seconds_since_prev_turn,
      input_tokens: input.usage.input_tokens,
      output_tokens: input.usage.output_tokens,
      cache_creation_input_tokens: input.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: input.usage.cache_read_input_tokens ?? 0,
      model: input.model,
    };

    // Defensive shallow copies on every boundary: emit a clone (so a
    // subscriber that mutates evt.payload can't reach the ring-buffer
    // entry), push another clone (so a caller of getUsageObservations()
    // mutating its result can't reach the live entry — orthogonal but
    // cheap), and copy input.usage (so the classifier's own ResultUsage
    // object can't alias lastResultUsage). UsageObservation and
    // ResultUsage are both flat; one spread layer is sufficient.
    await this.emit("usage_observation", { ...observation });

    this.turnSeq += 1;
    this.usageObservations.push({ ...observation });
    if (this.usageObservations.length > USAGE_OBSERVATION_BUFFER_CAPACITY) {
      this.usageObservations.shift();
    }
    this.lastResultTs = now.toISOString();
    this.lastResultUsage = { ...input.usage };
  }

  /**
   * In-memory snapshot of recent per-turn usage, capped at
   * USAGE_OBSERVATION_BUFFER_CAPACITY. Returns a deep copy so callers
   * can't mutate session state — UsageObservation is flat (all primitive
   * fields) so a shallow per-element spread is sufficient. Phase 6's cost
   * panel reads live data from here; historical data lives in the JSONL
   * via `usage_observation` envelope events.
   */
  getUsageObservations(): UsageObservation[] {
    return this.usageObservations.map((o) => ({ ...o }));
  }

  get endedSignal(): AbortSignal {
    return this.endedController.signal;
  }

  get taskId(): number | undefined { return this._taskId; }
  get runId(): string | undefined { return this._runId; }
  get phaseId(): string | undefined { return this._phaseId; }
  get endReason(): SessionEndReason | undefined { return this._endReason; }
  get successorSid(): string | null { return this._successorSid; }
  get permissionProfile(): PermissionProfile | null { return this._permissionProfile; }

  setPermissionProfile(profile: PermissionProfile): void {
    this._permissionProfile = profile;
  }

  attachSafirContext(runId: string, phaseId: string | undefined): void {
    this._runId = runId;
    this._phaseId = phaseId;
  }

  get compactor(): Compactor | null {
    return this._compactor;
  }

  attachCompactor(c: Compactor): void {
    if (this._compactor !== null) {
      throw new Error(
        `kbbl: attachCompactor called twice on session ${this.oakridgeSid}`,
      );
    }
    this._compactor = c;
  }

  markEndReason(reason: SessionEndReason): void {
    if (this._endReason !== undefined || this._status === "ended") return;
    this._endReason = reason;
  }

  /**
   * Records the oakridgeSid of the successor session that took over after a
   * successful compaction. Set by SessionManager.runCompact between
   * markEndReason("compacted") and abort(); idempotent (subsequent calls
   * with the same sid are no-ops; calls with a different sid throw to
   * surface a logic bug rather than silently overwrite).
   */
  markCompactedTo(successorSid: string): void {
    if (this._successorSid === successorSid) return;
    if (this._successorSid !== null) {
      throw new Error(
        `kbbl: markCompactedTo called twice on session ${this.oakridgeSid} ` +
          `(was=${this._successorSid}, now=${successorSid})`,
      );
    }
    this._successorSid = successorSid;
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    try {
      this.callbacks.onStatusChanged?.(this, status);
    } catch (e) {
      console.error(
        `kbbl: onStatusChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Manager-driven status transitions for the compaction lifecycle.
   * Validated to prevent accidental misuse (e.g. resurrecting an ended
   * session). markCompacting requires "live"; markLive requires
   * "compacting". No-ops on any other current status — callers (notably
   * runCompact's failure-revert) tolerate the no-op for safety.
   */
  markCompacting(): void {
    if (this._status !== "live") return;
    this.setStatus("compacting");
  }

  markLive(): void {
    if (this._status !== "compacting") return;
    this.setStatus("live");
  }

  snapshot(): SessionSnapshot {
    return {
      sid: this.oakridgeSid,
      name: this.name,
      workdir: this.workdir,
      status: this._status,
      createdAt: this.createdAt,
      lastActivityTs: this.lastActivityTs,
      ccSid: this.ccSid,
      parentCcSid: this.parentCcSid,
      parentOakridgeSid: this.parentOakridgeSid,
      artifactId: this.artifactId,
      pendingCount: this.pendingApprovals.size,
      yoloMode: this.yoloMode,
      allowedTools: [...this.allowedTools],
      lastResultUsage: this.lastResultUsage,
      worktreePath: this.worktreePath,
      worktreeBranch: this.worktreeBranch,
      worktreeBaseRef: this.worktreeBaseRef,
      projectWorkdir: this.projectWorkdir,
      model: this.model,
      endReason: this._endReason ?? null,
      successorSid: this._successorSid,
    };
  }

  async emit(type: string, payload: unknown): Promise<EnvelopeEvent> {
    if (this._status === "ended") {
      // A /hook/approval handler can still try to emit permission_resolved
      // after the subprocess dies mid-decision; finalize() flipped status
      // to "ended" and closed (or is about to close) the writer. Log and
      // return a sentinel instead of queueing work onto a doomed writer.
      console.error(
        `kbbl: dropping emit(${type}) on ended session ${this.oakridgeSid}`,
      );
      return { id: -1, type, ts: new Date().toISOString(), payload };
    }
    // Id assignment is synchronous (no await before `this.nextId++`), so
    // ids are monotonic in invocation order regardless of how many callers
    // race into emit. The queue below then preserves that same order for
    // the jsonl write and subscriber fan-out.
    const evt: EnvelopeEvent = {
      id: this.nextId++,
      type,
      ts: new Date().toISOString(),
      payload,
    };
    this.lastActivityTs = evt.ts;
    try {
      this.callbacks.onLastActivityChanged?.(this, evt.ts);
    } catch (e) {
      console.error(
        `kbbl: onLastActivityChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const persist = !this.nonPersistedEventTypes.has(type);
    const task = async () => {
      if (persist) {
        this.jsonlWriter.write(JSON.stringify(evt) + "\n");
        this.pendingFlushCount++;
      }
      for (const cb of this.subscribers) {
        try {
          cb(evt);
        } catch {
          // one subscriber's failure shouldn't affect others
        }
      }
      try {
        this.callbacks.onEmit?.(this, evt);
      } catch {
        // a badly-behaved manager hook mustn't corrupt per-session state
      }
    };
    const next = this.emitQueue.then(task, task);
    this.emitQueue = next;
    await next;
    return evt;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  async readJsonl(): Promise<string> {
    return readJsonlOrEmpty(this.jsonlPath);
  }

  /** Flush any buffered JSONL writes to disk. Tests that read the transcript
   *  immediately after emitting events must call this first. */
  async flushTranscript(): Promise<void> {
    const t = async () => { await this.jsonlWriter.flush(); };
    const next = this.emitQueue.then(t, t);
    this.emitQueue = next;
    this.pendingFlushCount = 0;
    await next;
  }

  async spawn(cmd: SpawnCmd): Promise<void> {
    if (this._spawnPromise) return this._spawnPromise;
    // Capture the promise synchronously (no await before this assignment
    // in the caller sequence) so a concurrent abort() can reliably find
    // it via the sync prefix of this call.
    this._spawnPromise = this._runSpawn(cmd);
    return this._spawnPromise;
  }

  private async _runSpawn(cmd: SpawnCmd): Promise<void> {
    await this.emit("session_started", {
      command: cmd.cmd,
      workdir: this.workdir,
      name: this.name,
      sessionId: this.oakridgeSid,
      parentCcSid: this.parentCcSid,
      parentOakridgeSid: this.parentOakridgeSid,
      artifactId: this.artifactId,
      worktreePath: this.worktreePath,
      worktreeBranch: this.worktreeBranch,
      worktreeBaseRef: this.worktreeBaseRef,
      projectWorkdir: this.projectWorkdir,
      model: this.model,
    });

    try {
      this.proc = Bun.spawn({
        cmd: cmd.cmd,
        cwd: cmd.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: cmd.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emit("subprocess_exited", {
        code: -1,
        reason: `spawn failed: ${msg}`,
      });
      await this.finalize();
      throw err;
    }

    this.setStatus("live");

    // Batch JSONL flushes every 100ms. Runs on a separate flushQueue so the
    // stdout pump's await this.emit() is never stalled waiting on disk I/O.
    // write() is synchronous so data is already buffered before flush fires;
    // there is no race between a pending write and an independent flush.
    this.flushInterval = setInterval(() => {
      if (this.flushInterval === null || this._status === "ended") return;
      if (this.pendingFlushCount === 0) return;
      this.pendingFlushCount = 0;
      const sid = this.oakridgeSid;
      this.flushQueue = this.flushQueue.then(async () => {
        try {
          await this.jsonlWriter.flush();
        } catch (err) {
          console.error(`kbbl: interval flush failed [${sid}]`, err);
        }
      });
    }, 100);

    const activeProc = this.proc;
    const procStdout = activeProc.stdout as ReadableStream<Uint8Array>;
    const procStderr = activeProc.stderr as ReadableStream<Uint8Array>;

    const fatalPumpError = (where: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`kbbl: ${where} [${this.oakridgeSid}] failed: ${msg}`);
      this.shutdownSignalReceived = true;
      activeProc.kill();
    };

    const stdoutPump = (async () => {
      for await (const line of readLines(procStdout)) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          const type = typeof raw?.type === "string" ? raw.type : "unknown";
          await this.emit(type, raw);
          // Runtime-adapter classifier: inspects the raw event for any
          // adapter-specific metadata (e.g., CC's system/init carries its
          // session_id; CC's result carries usage tokens). Errors here are
          // logged but never kill the pump.
          if (this.classifyEvent) {
            try {
              await this.classifyEvent(raw, this);
            } catch (e) {
              console.error(
                `kbbl: runtime classifier failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        } catch (err) {
          await this.emit("subprocess_stdout_parse_error", {
            line,
            error: (err as Error).message,
          });
        }
      }
    })().catch(fatalPumpError("stdout pump"));

    const stderrPump = (async () => {
      for await (const line of readLines(procStderr)) {
        await this.emit("subprocess_stderr", { line });
      }
    })().catch(fatalPumpError("stderr pump"));

    this.exitPromise = (async () => {
      const code = await activeProc.exited;
      // Wait for both pumps to drain their buffers — activeProc.exited can
      // resolve before readLines() has finished yielding the last of the
      // stdout/stderr lines. Without this, finalize() would flip _status
      // to "ended" and the trailing pump emits would short-circuit to
      // the sentinel branch.
      await Promise.allSettled([stdoutPump, stderrPump]);
      // finalize() must run even if the exit emit throws (disk full, perm
      // error), otherwise pending approvals stay parked and the jsonl
      // writer is never ended.
      try {
        await this.emit("subprocess_exited", {
          code,
          reason: this.shutdownSignalReceived
            ? "operator signal"
            : code === 0
              ? "clean"
              : "error",
        });
      } finally {
        await this.finalize();
      }
      return code;
    })();

    this.exitPromise.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `kbbl: session ${this.oakridgeSid} shutdown failed: ${msg}`,
      );
    });
  }

  private async finalize(): Promise<void> {
    // Idempotent: abort() and the exitPromise's finally can both race into
    // finalize; the first one wins and the second is a no-op.
    if (this._status === "ended") return;
    // Write terminal permission_resolved frames for every still-parked
    // approval BEFORE flipping status. Once setStatus("ended") runs, emit()
    // short-circuits, so if we resolved the pending promises first the
    // /hook/approval handler would race to emit its own
    // permission_resolved and hit the short-circuit — leaving the JSONL
    // with a permission_request that has no terminal resolution. Emitting
    // here (status still "live", writer still open) keeps the transcript
    // closed over every request.
    //
    // The .delete() below happens synchronously BEFORE the await, which
    // claims ownership of the request_id atomically. If a concurrent
    // /:sid/approval handler is resolving the same request, its
    // deleteApproval() either already ran (we see .get() === undefined
    // and skip) or races and finds nothing — either way only one
    // permission_resolved entry makes it to the JSONL.
    const parkedRequestIds = [...this.pendingApprovals.keys()];
    let resolvedCount = 0;
    for (const requestId of parkedRequestIds) {
      const pending = this.pendingApprovals.get(requestId);
      if (!pending) continue;
      this.pendingApprovals.delete(requestId);
      try {
        await this.emit("permission_resolved", {
          request_id: requestId,
          decision: "deny",
          reason: "session_ended",
        });
      } catch (err) {
        console.error(
          `kbbl: failed to emit terminal permission_resolved for ${requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        pending.resolve("deny");
      } catch {
        // ignore
      }
      resolvedCount++;
    }
    if (this._compactor) {
      try {
        this._compactor.observeSessionEnded();
      } catch (err) {
        console.error(
          `kbbl: compactor.observeSessionEnded threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Flip status BEFORE draining so any emit() racing with finalize sees
    // the ended flag and short-circuits instead of queueing new writes
    // onto a writer we're about to close.
    this.setStatus("ended");
    // Unblock long-lived consumers (SSE streams, subscribers) waiting on
    // events from this session. Done before resolving pending approvals so
    // stream loops see the aborted signal promptly.
    this.endedController.abort();
    // Sweep anything that slipped in during the emit loop (a /hook/approval
    // that racked between our status check and the final clear). These are
    // resolved without a JSONL entry since status is now ended; the
    // handler's own emit will short-circuit as before.
    const hadStragglers = this.pendingApprovals.size > 0;
    for (const [, pending] of this.pendingApprovals) {
      try {
        pending.resolve("deny");
      } catch {
        // ignore
      }
    }
    this.pendingApprovals.clear();
    if (resolvedCount > 0 || hadStragglers) this.firePendingCountChanged();
    // Stop the flush interval, wait for any in-flight background flush, then
    // do a final flush so writes buffered since the last tick reach disk.
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flushQueue;
    const finalFlush = async () => { await this.jsonlWriter.flush(); };
    this.emitQueue = this.emitQueue.then(finalFlush, finalFlush);
    // Drain in-flight emit work (write+flush+fanout) before closing the
    // writer — otherwise queued tasks that were accepted before the status
    // flip would hit an ended writer.
    try {
      await this.emitQueue;
    } catch (err) {
      console.error(
        `kbbl: emit queue drain failed for ${this.oakridgeSid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      await this.jsonlWriter.end();
    } catch (err) {
      console.error(
        `kbbl: jsonl writer end failed for ${this.oakridgeSid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      this.callbacks.onEnded?.(this);
    } catch (e) {
      console.error(
        `kbbl: onEnded callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (this._compactor) {
      try {
        this._compactor.dispose();
      } catch (err) {
        console.error(
          `kbbl: compactor.dispose threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  async writeInput(
    text: string,
    opts: { internal?: boolean } = {},
  ): Promise<void> {
    // External writes (HTTP /:sid/input) require status === "live".
    // Internal writes (runCompact's COMPACT_PROMPT, successor handoff
    // delivery) are also allowed in "compacting" — that's the only state
    // where they need to slip through, and the parameter (rather than a
    // shared session-level flag) makes the gate per-call so an external
    // POST during compaction can't piggy-back on runCompact's
    // authorization.
    const isInternal = opts.internal === true;
    const allowedDuringCompacting =
      this._status === "compacting" && isInternal;
    if (
      !this.proc ||
      (this._status !== "live" && !allowedDuringCompacting)
    ) {
      throw new SessionNotReadyError();
    }
    const stdin = this.proc.stdin as import("bun").FileSink;
    const task = async () => {
      const line =
        JSON.stringify({
          type: "user",
          message: { role: "user", content: text },
        }) + "\n";
      stdin.write(line);
      await stdin.flush();
    };
    this.inputQueue = this.inputQueue.then(task, task);
    // Notify the compactor BEFORE awaiting the queue. If a prior write
    // is still flushing, the compaction timer could fire in the gap
    // between "we accepted this user message" and "we finished writing
    // the previous one" — and runCompact would start despite fresh
    // operator activity having been accepted. Internal writes don't
    // represent a fresh user message — they shouldn't cancel a
    // scheduled compaction by feeding observeUserMessage.
    if (!isInternal && this._compactor) {
      try {
        this._compactor.observeUserMessage();
      } catch (err) {
        console.error(
          `kbbl: compactor.observeUserMessage threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await this.inputQueue;
  }

  registerApproval(requestId: string, pending: PendingApproval): void {
    this.pendingApprovals.set(requestId, pending);
    this.firePendingCountChanged();
  }

  deleteApproval(requestId: string): PendingApproval | undefined {
    const p = this.pendingApprovals.get(requestId);
    if (p) {
      this.pendingApprovals.delete(requestId);
      this.firePendingCountChanged();
    }
    return p;
  }

  private firePendingCountChanged(): void {
    try {
      this.callbacks.onPendingCountChanged?.(this, this.pendingApprovals.size);
    } catch (e) {
      console.error(
        `kbbl: onPendingCountChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (this._compactor) {
      try {
        this._compactor.observePendingApprovalChange(this.pendingApprovals.size);
      } catch (err) {
        console.error(
          `kbbl: compactor.observePendingApprovalChange threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  getApproval(requestId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(requestId);
  }

  hasApproval(requestId: string): boolean {
    return this.pendingApprovals.has(requestId);
  }

  get yolo(): boolean {
    return this.yoloMode;
  }

  get toolAllowlist(): ReadonlySet<string> {
    return this.allowedTools;
  }

  /**
   * Emits yolo_mode_changed and flips yoloMode, but only when the value
   * actually changes. The emit happens before the mutation so the JSONL log
   * stays authoritative if emit throws.
   */
  async setYolo(enabled: boolean): Promise<boolean> {
    if (this.yoloMode === enabled) return this.yoloMode;
    await this.emit("yolo_mode_changed", { enabled });
    this.yoloMode = enabled;
    try {
      this.callbacks.onYoloChanged?.(this, this.yoloMode);
    } catch (e) {
      console.error(
        `kbbl: onYoloChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (this.yoloMode) this.drainParkedFor(() => true);
    return this.yoloMode;
  }

  /**
   * Adds a tool to this session's allowlist and drains any parked approvals
   * for that tool. Idempotent: if the tool is already allowlisted, returns
   * without emitting.
   */
  async allowlistTool(toolName: string): Promise<void> {
    if (this.allowedTools.has(toolName)) return;
    await this.emit("tool_allowlisted", { tool_name: toolName });
    this.allowedTools.add(toolName);
    this.drainParkedFor((p) => p.toolName === toolName);
  }

  drainParkedFor(predicate: (a: PendingApproval) => boolean): void {
    let drained = false;
    for (const [requestId, pending] of this.pendingApprovals) {
      if (!predicate(pending)) continue;
      this.pendingApprovals.delete(requestId);
      pending.resolve("allow");
      drained = true;
    }
    if (drained) this.firePendingCountChanged();
  }

  async abort(): Promise<number> {
    this.shutdownSignalReceived = true;
    // Wait for spawn to finish wiring (or fail). Without this, an abort
    // arriving in the "starting" window could finalize() the session
    // while _runSpawn() is still mid-way through wiring pumps, producing
    // write-after-end on the jsonl writer.
    if (this._spawnPromise) {
      try {
        await this._spawnPromise;
      } catch {
        // Spawn failed and finalize() already ran; fall through to the
        // ended-state handling below.
      }
    }
    if (this._status === "ended") {
      if (this.exitPromise) {
        try {
          return await this.exitPromise;
        } catch {
          return 1;
        }
      }
      // Ended without an exitPromise means _runSpawn() threw (Bun.spawn
      // failed) before we wired the exit handler. That's a failure, not
      // a clean exit — report non-zero so endAll()/DELETE aggregate it
      // as an error.
      return 1;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // proc may already be dead; finalize via exitPromise handles it
      }
    }
    if (this.exitPromise) {
      try {
        return await this.exitPromise;
      } catch {
        return 1;
      }
    }
    // No exit promise wired (spawn was never called or Session was used
    // outside the manager); finalize synchronously to clean up.
    await this.finalize();
    return 1;
  }
}

export class SessionNotReadyError extends Error {
  constructor() {
    super("subprocess not ready");
    this.name = "SessionNotReadyError";
  }
}

export function extractResultUsage(payload: unknown): ResultUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : null;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : null;
  if (input === null || output === null) return null;
  const result: ResultUsage = {
    input_tokens: input,
    output_tokens: output,
  };
  if (typeof u.cache_creation_input_tokens === "number") {
    result.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === "number") {
    result.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  return result;
}

export function newSessionId(): SessionId {
  return randomUUID() as SessionId;
}

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const trimCR = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0) yield trimCR(buf);
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        yield trimCR(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
