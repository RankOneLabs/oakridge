import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Compactor } from "./compactor";
import type { AgentRuntime, RuntimeId, SessionHandle } from "../runtime";
import type {
  ArtifactId,
  ResultUsage,
  SessionEndReason,
  SessionId,
  SessionSnapshot,
  SessionStatus,
} from "./types";

export type {
  ArtifactId,
  ResultUsage,
  SessionEndReason,
  SessionId,
  SessionSnapshot,
  SessionStatus,
} from "./types";

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
  /** @deprecated Use onRuntimeSessionObserved */
  onCcSidObserved?: (session: Session, ccSid: string) => void;
  onRuntimeSessionObserved?: (session: Session, runtimeSid: string) => void;
  onEnded?: (session: Session) => void;
  onEmit?: (session: Session, evt: EnvelopeEvent) => void;
  onStatusChanged?: (session: Session, status: SessionStatus) => void;
  onPendingCountChanged?: (session: Session, count: number) => void;
  onLastActivityChanged?: (session: Session, ts: string) => void;
  onYoloChanged?: (session: Session, yoloMode: boolean) => void;
  onRuntimeModelObserved?: (session: Session, model: string) => void;
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
  /**
   * Runtime adapter id for this session. Defaults to "claude-code" when
   * omitted to preserve backward compatibility with callers that don't yet
   * pass a runtime.
   */
  runtimeId?: RuntimeId;
  parentCcSid?: string;
  parentOakridgeSid?: string;
  /**
   * Opaque identifier from legit-biz-club tagging this session as part of
   * an artifact-scoped ensemble. kbbl doesn't model the artifact itself —
   * the id is passed through to snapshots and queryable via
   * SessionManager.listByArtifact() for grouping in the operator UI.
   */
  artifactId?: ArtifactId;
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
  /**
   * Milliseconds a dispatched operator message may stay "busy" with no
   * observed turn-start before the input-queue watchdog assumes it was
   * swallowed (e.g. by a CC startup modal) and recovers the queue. Override
   * only in tests; production uses {@link BUSY_TURN_WATCHDOG_MS}.
   */
  busyWatchdogMs?: number;
}

/**
 * Default for {@link SessionOpts.busyWatchdogMs}. A real turn writes its first
 * transcript line (the user message) within ~1s of submission — well inside
 * this window — so the watchdog only fires when a dispatched message produced
 * no turn at all. Generous enough that transcript-tailer poll/debounce latency
 * never trips it on a legitimate turn.
 */
export const BUSY_TURN_WATCHDOG_MS = 15_000;

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
  readonly runtimeId: RuntimeId;
  readonly parentCcSid: string | null;
  readonly parentOakridgeSid: string | null;
  readonly artifactId: ArtifactId | null;
  readonly createdAt: string;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly worktreeBaseRef: string | null;
  readonly projectWorkdir: string | null;
  readonly model: string | null;

  private _endReason: SessionEndReason | undefined;
  private _successorSid: string | null = null;
  private _compactor: Compactor | null = null;
  private _runtime: AgentRuntime | null = null;
  private _handle: SessionHandle | null = null;

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
  private _runtimeSid: string | null = null;
  private _status: SessionStatus = "starting";
  private shutdownSignalReceived = false;
  private lastActivityTs: string;
  private yoloMode = false;
  private allowedTools = new Set<string>();
  private lastResultUsage: ResultUsage | null = null;
  // Runtime-observed model ids: initial is first-wins for launch truth,
  // observed is last-wins so current subagent/runtime activity stays visible.
  private observedModel: string | null = null;
  private _initialObservedModel: string | null = null;
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
  // Turn-state and pending input queue for the attached-runtime path (CC PTY).
  // turnState gates the queue: only one operator message goes to the PTY at a
  // time; the next waits for the Stop hook to call notifyTurnEnd(). Internal
  // writes (compaction, handoff) bypass both fields entirely.
  private turnState: "idle" | "busy" = "idle";
  private pendingInput: string[] = [];
  // Watchdog that recovers the queue if a dispatched message never becomes a
  // turn (e.g. swallowed by a CC startup modal) and so never yields a Stop
  // hook. Armed when a message is sent; cleared once a turn is observed to
  // start (notifyTurnStarted) or end (notifyTurnEnd). See pumpInputQueue.
  private busyWatchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly busyWatchdogMs: number;
  // The message currently dispatched to the PTY (claimed by pumpInputQueue).
  // Held so the watchdog can re-deliver it once if it produced no turn.
  private lastDispatched: string | null = null;
  // True when the in-flight dispatch is a fresh message eligible for exactly
  // one watchdog re-delivery. Cleared once that re-delivery is used so a
  // genuinely unprocessable message can't loop forever.
  private redeliverArmed = false;
  // Set by the watchdog when it re-queues lastDispatched; tells the next
  // pumpInputQueue dispatch that it IS that re-delivery (so it does not grant
  // the same message another retry).
  private nextDispatchIsRetry = false;
  // Aborts when finalize() runs so long-lived consumers (SSE streams,
  // subscribers) can exit their loops instead of hanging on a dead session.
  private readonly endedController = new AbortController();

  constructor(opts: SessionOpts) {
    this.oakridgeSid = opts.oakridgeSid as SessionId;
    this.workdir = opts.workdir;
    this.name = opts.name;
    this.jsonlPath = join(opts.sessionsDir, `${opts.oakridgeSid}.jsonl`);
    this.runtimeId = opts.runtimeId ?? "claude-code";
    this.parentCcSid = opts.parentCcSid ?? null;
    this.parentOakridgeSid = opts.parentOakridgeSid ?? null;
    // Normalize at the constructor so direct SessionManager.create()
    // callers can't sneak in empty/whitespace or oversized tags even
    // though the HTTP route rejects them. JSONL session_started and
    // snapshots will never contain a malformed artifactId regardless
    // of call site.
    let artifactId: ArtifactId | null = null;
    if (opts.artifactId !== undefined) {
      const trimmedArtifactId = opts.artifactId.trim();
      if (trimmedArtifactId === "") {
        throw new Error("artifactId must be non-empty when provided");
      }
      if (trimmedArtifactId.length > MAX_ARTIFACT_ID_LENGTH) {
        throw new Error(
          `artifactId must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming (got ${trimmedArtifactId.length})`,
        );
      }
      artifactId = trimmedArtifactId as ArtifactId;
    }
    this.artifactId = artifactId;
    this.worktreePath = opts.worktreePath ?? null;
    this.worktreeBranch = opts.worktreeBranch ?? null;
    this.worktreeBaseRef = opts.worktreeBaseRef ?? null;
    this.projectWorkdir = opts.projectWorkdir ?? null;
    this.model = opts.model ?? null;
    this.createdAt = new Date().toISOString();
    this.lastActivityTs = this.createdAt;
    this.lastResultTs = this.createdAt;
    this.callbacks = opts.callbacks ?? {};
    this.classifyEvent = opts.classifyEvent;
    this.nonPersistedEventTypes = opts.nonPersistedEventTypes ?? new Set();
    this.busyWatchdogMs = opts.busyWatchdogMs ?? BUSY_TURN_WATCHDOG_MS;
    this.jsonlWriter = Bun.file(this.jsonlPath).writer();
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentCcSid(): string | null {
    return this.runtimeId === "claude-code" ? this._runtimeSid : null;
  }

  /**
   * Most recent runtime-observed model id, or null until the classifier
   * has called observeRuntimeModel(). Exposed so the CC classifier can
   * enforce first-wins seeding on system+init (only call observe… when
   * this is still null) while letting assistant turns update last-wins.
   * Read-only by design — mutation happens through observeRuntimeModel.
   */
  get currentObservedModel(): string | null {
    return this.observedModel;
  }

  get initialObservedModel(): string | null {
    return this._initialObservedModel;
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
    if (this._runtimeSid !== null) return;
    // Emit the CC-specific legacy event only for CC sessions so non-CC runtimes
    // don't produce CC-named events in their transcripts.
    if (this.runtimeId === "claude-code") {
      await this.emit("cc_session_id_observed", { cc_session_id: id });
    }
    await this.emit("runtime_session_observed", { runtime_sid: id, runtime_id: this.runtimeId });
    this._runtimeSid = id;
    // onCcSidObserved is a CC-specific callback; only fire for CC sessions.
    if (this.runtimeId === "claude-code") {
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
    try {
      this.callbacks.onRuntimeSessionObserved?.(this, id);
    } catch (e) {
      console.error(
        `kbbl: onRuntimeSessionObserved callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Runtime-adapter injection point: called by the classifier whenever the
   * underlying runtime reveals the model it actually resolved. CC seeds this
   * via system+init.model (within ~1s of spawn) and updates it on every
   * assistant.message.model — subagents firing under a different model
   * surface here too.
   *
   * Idempotent: an early-return on `model === this.observedModel` keeps the
   * common steady-state case (same model across assistant turns) from
   * emitting one envelope event per turn. Emit-before-mutate matches the
   * pattern used by observeRuntimeSessionId/setYolo/allowlistTool — if the
   * JSONL flush throws, model state stays at the prior value and a later
   * event can retry cleanly.
   *
   * No allowlist gate: observedModel captures runtime truth, not operator
   * intent. CC can resolve to date-suffixed snapshot ids or future model
   * versions that aren't in ALLOWED_MODELS, and dropping those would defeat
   * the cohort. `model` (spawn-time intent) keeps its allowlist gate
   * separately because that field validates user input.
   */
  async observeRuntimeModel(model: string): Promise<void> {
    if (model === this.observedModel) return;
    await this.emit("model_observed", { model });
    if (this._initialObservedModel === null) {
      this._initialObservedModel = model;
    }
    this.observedModel = model;
    try {
      this.callbacks.onRuntimeModelObserved?.(this, model);
    } catch (e) {
      console.error(
        `kbbl: onRuntimeModelObserved callback failed: ${
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

  get endReason(): SessionEndReason | undefined { return this._endReason; }
  get successorSid(): string | null { return this._successorSid; }

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
    // Flush any messages queued during compaction now that the session is live.
    this.pumpInputQueue();
  }

  snapshot(): SessionSnapshot {
    return {
      sid: this.oakridgeSid,
      name: this.name,
      workdir: this.workdir,
      status: this._status,
      createdAt: this.createdAt,
      lastActivityTs: this.lastActivityTs,
      runtimeId: this.runtimeId,
      runtimeSid: this._runtimeSid,
      ccSid: this.runtimeId === "claude-code" ? this._runtimeSid : null,
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
      initialObservedModel: this._initialObservedModel,
      observedModel: this.observedModel,
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

  /**
   * New orchestration entrypoint: the session manager calls this after
   * the runtime adapter has spawned its subprocess/process. The session
   * drives the event loop from `runtime.events(handle)` rather than
   * directly owning a Bun.spawn proc.
   *
   * If `spawn()` was already called on this session (legacy path), this
   * is a no-op to prevent double-wiring.
   */
  async attachRuntime(runtime: AgentRuntime, handle: SessionHandle): Promise<void> {
    if (this._spawnPromise) return this._spawnPromise;
    this._runtime = runtime;
    this._handle = handle;
    // _spawnPromise resolves once wiring is complete (session_started emitted,
    // status=live). The event loop runs as a background task via exitPromise so
    // create() / POST /sessions return immediately with a live session rather
    // than blocking until the runtime terminates. This mirrors spawn()'s
    // contract: _spawnPromise = wiring done, exitPromise = session lifetime.
    this._spawnPromise = this._wireAttached(runtime, handle);
    return this._spawnPromise;
  }

  private async _wireAttached(runtime: AgentRuntime, handle: SessionHandle): Promise<void> {
    await this.emit("session_started", {
      command: [],
      workdir: this.workdir,
      name: this.name,
      sessionId: this.oakridgeSid,
      runtimeId: this.runtimeId,
      parentCcSid: this.parentCcSid,
      parentOakridgeSid: this.parentOakridgeSid,
      artifactId: this.artifactId,
      worktreePath: this.worktreePath,
      worktreeBranch: this.worktreeBranch,
      worktreeBaseRef: this.worktreeBaseRef,
      projectWorkdir: this.projectWorkdir,
      model: this.model,
    });
    if (handle.runtimeSid) await this.observeRuntimeSessionId(handle.runtimeSid);
    if (handle.resolvedModel) await this.observeRuntimeModel(handle.resolvedModel);

    this.setStatus("live");
    // Flush any messages that were queued before the session became live.
    this.pumpInputQueue();

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

    this.exitPromise = this._runAttachedLoop(runtime, handle);
  }

  private async _runAttachedLoop(runtime: AgentRuntime, handle: SessionHandle): Promise<number> {
    const classifyEvent = runtime.classifyEvent?.bind(runtime);
    let completedResult: unknown = null;
    let hadRuntimeError = false;

    try {
      for await (const event of runtime.events(handle)) {
        if (this._status === "ended") break;
        if (event.type === "envelope") {
          const raw = event.payload;
          const type =
            typeof (raw as { type?: unknown })?.type === "string"
              ? (raw as { type: string }).type
              : "unknown";
          await this.emit(type, raw);
          if (classifyEvent) {
            try {
              await classifyEvent(raw, this);
            } catch (e) {
              console.error(
                `kbbl: runtime classifier failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        } else if (event.type === "completed") {
          completedResult = event.result;
          break;
        } else if (event.type === "error") {
          console.error(
            `kbbl: runtime error [${this.oakridgeSid}]: ${event.message}`,
          );
          hadRuntimeError = true;
          break;
        }
      }
    } catch (err) {
      console.error(
        `kbbl: event loop error [${this.oakridgeSid}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      hadRuntimeError = true;
    }

    const exitCode = hadRuntimeError
      ? 1
      : completedResult &&
          typeof (completedResult as { code?: unknown }).code === "number"
        ? (completedResult as { code: number }).code
        : 1;

    try {
      await this.emit("subprocess_exited", {
        code: exitCode,
        reason: this.shutdownSignalReceived ? "operator signal" : exitCode === 0 ? "clean" : "error",
      });
    } finally {
      await this.finalize();
    }

    return exitCode;
  }

  private async _runSpawn(cmd: SpawnCmd): Promise<void> {
    await this.emit("session_started", {
      command: cmd.cmd,
      workdir: this.workdir,
      name: this.name,
      sessionId: this.oakridgeSid,
      runtimeId: this.runtimeId,
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
    // Drop any undelivered queued messages — the subprocess is gone.
    this.pendingInput = [];
    this.clearBusyWatchdog();
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

  /**
   * Single entry point that advances the pending-input queue by one message.
   * All synchronous state mutations happen before any await (shift + turnState)
   * so concurrent calls from writeInput and notifyTurnEnd can't both pass the
   * guard and double-send. Only applies to the attached-runtime path without
   * synthesizeUserInputEvents (i.e., CC PTY mode); other paths never enqueue.
   */
  private pumpInputQueue(): void {
    if (
      this._status !== "live" ||
      this.turnState !== "idle" ||
      this.pendingInput.length === 0
    ) return;
    if (this._runtime === null || this._handle === null) return;
    // Claim the message and transition to busy before any await. JS is
    // single-threaded, so this block is atomic with respect to other callers.
    const msg = this.pendingInput.shift() as string; // length > 0 checked above
    this.turnState = "busy";
    this.lastDispatched = msg;
    if (this.nextDispatchIsRetry) {
      // This dispatch is the one-shot re-delivery of a previously lost
      // message — don't grant it another retry.
      this.nextDispatchIsRetry = false;
      this.redeliverArmed = false;
    } else {
      // Fresh message — eligible for exactly one watchdog re-delivery.
      this.redeliverArmed = true;
    }
    const runtime = this._runtime;
    const handle = this._handle;
    const task = async () => {
      try {
        await runtime.send(handle, msg);
        // Arm the watchdog only after the message is actually written to the
        // PTY — not at queue-claim. The CC readiness gate makes send() await
        // the REPL coming up; arming earlier would start the "no turn" clock
        // while the message is still waiting to be written and could trip a
        // spurious re-delivery. Armed here, the timer measures "no turn after
        // write". notifyTurnStarted() (which cancels it) is driven by the
        // transcript tailer and so can't fire until CC has received this
        // message — i.e. after this write — so arming here never races it.
        this.armBusyWatchdog();
      } catch (err) {
        // send() failed (e.g. CC proc already gone). Reset state so the queue
        // isn't permanently wedged; finalize() will clear pendingInput shortly.
        console.error(
          `kbbl: runtime.send failed [${this.oakridgeSid}]: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Nothing was armed for this dispatch (arming happens only after a
        // successful send), but clear defensively in case a prior timer lingers.
        this.clearBusyWatchdog();
        this.turnState = "idle";
        this.pumpInputQueue();
      }
    };
    this.inputQueue = this.inputQueue.then(task, task);
  }

  /**
   * Called by the CC adapter's Stop hook handler when the main agent finishes
   * a turn. Sets turn-state to idle and pumps the next queued message (if any).
   * Idempotent: calling while already idle just re-pumps (no-op when queue is
   * empty). The Stop hook guarantees exactly one call per turn, so no debounce
   * or dedup is needed here.
   */
  notifyTurnEnd(): void {
    this.clearBusyWatchdog();
    this.turnState = "idle";
    this.pumpInputQueue();
  }

  /**
   * Called when a transcript event proves CC actually began processing the
   * dispatched message (any user/assistant/result line appeared). Cancels the
   * busy watchdog — the turn is legitimately running and will end via the Stop
   * hook (notifyTurnEnd). Leaves turnState "busy"; does NOT pump the queue.
   */
  notifyTurnStarted(): void {
    this.clearBusyWatchdog();
  }

  /**
   * Arm (or re-arm) the watchdog for the message just dispatched. If no
   * turn-start is observed within busyWatchdogMs, the message was consumed
   * without starting a turn (no Stop hook will follow) — recover via
   * notifyTurnEnd so queued messages aren't stranded behind a stuck "busy".
   */
  private armBusyWatchdog(): void {
    this.clearBusyWatchdog();
    this.busyWatchdog = setTimeout(() => {
      this.busyWatchdog = null;
      if (this.turnState !== "busy") return;
      // With the transcript tailer running from launch, any real turn cancels
      // this watchdog via notifyTurnStarted(). Reaching here means the
      // dispatched message produced no turn at all — written before the REPL
      // was ready, or swallowed. Re-deliver it once before recovering so a
      // genuinely lost message isn't silently dropped; if this was already the
      // re-delivery, drop it so an unprocessable message can't loop forever.
      if (this.redeliverArmed && this.lastDispatched !== null) {
        this.redeliverArmed = false;
        this.nextDispatchIsRetry = true;
        this.pendingInput.unshift(this.lastDispatched);
        console.error(
          `kbbl: input queue watchdog fired [${this.oakridgeSid}] — dispatched message produced no turn after ${this.busyWatchdogMs}ms; re-delivering once`,
        );
      } else {
        console.error(
          `kbbl: input queue watchdog fired [${this.oakridgeSid}] — re-delivered message still produced no turn after ${this.busyWatchdogMs}ms; recovering queue`,
        );
      }
      this.notifyTurnEnd();
    }, this.busyWatchdogMs);
    // Don't let the watchdog timer keep the event loop alive on its own.
    this.busyWatchdog.unref?.();
  }

  private clearBusyWatchdog(): void {
    if (this.busyWatchdog !== null) {
      clearTimeout(this.busyWatchdog);
      this.busyWatchdog = null;
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
    //
    // External attached-runtime writes without synthesizeUserInputEvents (CC
    // PTY mode) are additionally accepted during "compacting": they are queued
    // and flushed once the session returns to "live" via markLive(). The
    // attached check is inside the block below — this outer gate accepts
    // "compacting" only when that condition would hold.
    const isInternal = opts.internal === true;
    const isAttachedExternal =
      !isInternal &&
      this._runtime !== null &&
      this._handle !== null &&
      this._runtime.synthesizeUserInputEvents !== true;
    const allowedDuringCompacting =
      this._status === "compacting" && (isInternal || isAttachedExternal);
    // Accept writes when using the attached runtime path too (no proc).
    const hasWriteTarget = this.proc !== null || (this._runtime !== null && this._handle !== null);
    if (
      !hasWriteTarget ||
      (this._status !== "live" && !allowedDuringCompacting)
    ) {
      throw new SessionNotReadyError();
    }

    // Attached-runtime path.
    if (this._runtime !== null && this._handle !== null) {
      const runtime = this._runtime;
      const handle = this._handle;

      if (isInternal) {
        // Internal writes bypass the turn queue: compaction prompts and
        // handoff delivery are not operator turns and must not be held.
        const task = async () => { await runtime.send(handle, text); };
        this.inputQueue = this.inputQueue.then(task, task);
        await this.inputQueue;
        return;
      }

      if (runtime.sendsWithoutTurnQueue === true) {
        // Immediate-send runtimes (Codex) have no Stop hook, so the turn-state
        // machine is never driven and queuing would deadlock — send right away.
        // Synthesis is a separate opt-in: emit the `user` row only when the
        // runtime doesn't echo input back (synthesizeUserInputEvents).
        const task = async () => {
          if (runtime.synthesizeUserInputEvents === true) {
            await this.emit("user", {
              type: "user",
              message: { role: "user", content: text },
            });
          }
          await runtime.send(handle, text);
        };
        this.inputQueue = this.inputQueue.then(task, task);
        if (this._compactor) {
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
        return;
      }

      // Turn-queue delivery path (Claude Code): operator input is deferred to
      // turn boundaries via pumpInputQueue/notifyTurnEnd. Synthesize the `user`
      // event when the runtime opts in (synthesizeUserInputEvents) — CC's
      // channel transport does not echo operator input back as a transcript
      // event the way PTY input did via CC's output stream, so without this the
      // operator message would never appear in the JSONL or the PWA inbox.
      if (runtime.synthesizeUserInputEvents === true) {
        await this.emit("user", {
          type: "user",
          message: { role: "user", content: text },
        });
      }
      // Push onto the pending queue. Return once accepted — do not await
      // delivery to the channel outbox. pumpInputQueue() will send immediately
      // if the turn is idle, or defer until notifyTurnEnd().
      this.pendingInput.push(text);
      if (this._compactor) {
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
      this.pumpInputQueue();
      return;
    }

    // Legacy stdin/Bun.spawn path — no turn queue (behavior unchanged).
    // proc is non-null here: hasWriteTarget passed and runtime/handle are null.
    const stdin = this.proc!.stdin as import("bun").FileSink;
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

  /** Resolves with the exit code when the session finishes naturally. */
  waitForEnd(): Promise<number> {
    return this.exitPromise ?? Promise.resolve(1);
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
    if (this._runtime && this._handle) {
      try {
        await this._runtime.terminate(this._handle);
      } catch {
        // runtime may already be done; exitPromise handles finalization
      }
    } else if (this.proc) {
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

export function extractResultUsage(payload: unknown): ResultUsage | null {
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
