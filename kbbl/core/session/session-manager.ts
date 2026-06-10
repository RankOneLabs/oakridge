import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { KbblConfig } from "../config";
import type { EpicIdentity } from "../orchestrator/backends/interface";

export class NonGitWorkdirError extends Error {
  constructor(workdir: string) {
    super(`kbbl: workdir ${workdir} is not a git repo — sessions require a worktree-capable workdir`);
    this.name = "NonGitWorkdirError";
  }
}
import {
  MAX_ARTIFACT_ID_LENGTH,
  Session,
  extractResultUsage,
  newSessionId,
  readJsonlOrEmpty,
  type ArtifactId,
  type EnvelopeEvent,
  type ResultUsage,
  type SessionEndReason,
  type SessionSnapshot,
  type SessionStatus,
  type SpawnCmd,
} from "./session";
import { Compactor, type CompactReason } from "./compactor";
import { COMPACT_PROMPT } from "./compact-prompt";
import { parseHandoffMarkdown } from "./handoff-doc";
import {
  WorktreeCreateError,
  createWorktree,
  isGitRepo,
  isPathInside,
  removeWorktree,
  resolveRepoTopLevel,
} from "./worktree";
import type { RuntimeId, RuntimeRegistry } from "../runtime";
import type { DelegatedCallback, OutputSlot } from "../server/callbacks";
import { reportTerminalStatus } from "../server/callbacks";

export interface SessionManagerOpts {
  sessionsDir: string;
  /**
   * Directory where compaction handoff markdown is persisted, one file
   * per old session keyed by oakridgeSid. Threaded explicitly (rather
   * than derived from sessionsDir) so manager consumers don't bake in
   * the `<dataDir>/sessions` + `<dataDir>/handoffs` sibling layout.
   */
  handoffsDir: string;
  /**
   * Parent dir of all per-session worktrees: `<dataDir>/<worktree_dir_name>`.
   * Created by the server at startup before the manager is constructed.
   * Required even when worktrees are off so the manager doesn't have to
   * branch on the flag at every consumer.
   */
  worktreesDir: string;
  /**
   * Build the command + spawn env for a new session. Receives the session
   * object (so the manager doesn't need to know which flags come from where)
   * and returns a SpawnCmd ready to hand to Bun.spawn. Resume is expressed
   * via parentCcSid on the Session, not as a separate flag here — the
   * builder inspects session.parentCcSid.
   *
   * Legacy option kept for backward compat. New code should use `registry`
   * and the AgentRuntime.spawn() path instead.
   */
  buildSpawnCmd?: (session: Session) => Promise<SpawnCmd>;
  /**
   * Optional runtime-adapter classifier wired into each Session's stdout
   * pump. The adapter inspects raw events and updates Session metadata
   * (observeRuntimeSessionId, observeTurnEnd). Adapters with no
   * per-event work omit this.
   *
   * Legacy option; when `registry` is provided the runtime's classifyEvent
   * is used from the AgentRuntime interface directly.
   */
  classifyEvent?: (rawEvent: unknown, session: Session) => Promise<void>;
  /**
   * Optional set of event types Session.emit() will broadcast but skip
   * writing to the JSONL transcript. See AppRuntime.nonPersistedEventTypes
   * for rationale.
   *
   * Legacy option; when `registry` is provided, runtime.nonPersistedEventTypes
   * is used from the AgentRuntime interface directly.
   */
  nonPersistedEventTypes?: ReadonlySet<string>;
  /**
   * Runtime registry. When provided, the manager uses
   * `registry.runtimes.get(runtimeId).spawn()` + `session.attachRuntime()`
   * instead of the legacy `buildSpawnCmd` + `session.spawn()` path.
   * The default runtime id is `registry.defaultId`.
   */
  registry?: RuntimeRegistry;
  /**
   * Optional lookup callback: given a CC session id (from CC's system/init
   * session_id), return the Session for it. The CC adapter owns the
   * ccSid→oakridgeSid map and provides this callback. When absent,
   * getByCcSid() always returns undefined.
   */
  lookupByCcSid?: (ccSid: string) => Session | undefined;
  /**
   * Called when a session's runtime session id is first observed (i.e. when
   * the runtime emits its internal session id, e.g. CC's system/init
   * session_id). The CC adapter uses this to register the mapping in its
   * internal ccSidToOakridgeSid map.
   */
  onRuntimeSessionObserved?: (session: Session, runtimeSid: string) => void;
  /**
   * Called when a session ends. Provides a hook for the adapter to clean up
   * any runtime-session-id mappings it holds.
   */
  onRuntimeSessionEnded?: (session: Session) => void;
  /**
   * Validated kbbl config (compact thresholds, retention window). Loaded
   * once at server startup and threaded through here so consumers
   * (compactor, retention sweep) can read from a single source of truth.
   */
  config: KbblConfig;
}

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
  readonly tools?: unknown;
  readonly yoloMode?: unknown;
  readonly worktreePath?: unknown;
  readonly worktreeBranch?: unknown;
  readonly worktreeBaseRef?: unknown;
  readonly projectWorkdir?: unknown;
  readonly model?: unknown;
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

export interface CreateSessionOpts {
  workdir: string;
  name?: string;
  parentCcSid?: string;
  parentOakridgeSid?: string;
  /**
   * Tag this session with an artifact id. Sessions sharing an
   * artifactId can be enumerated via SessionManager.listByArtifact() —
   * the workspace layer (legit-biz-club) uses this to track ensembles
   * working on the same artifact. kbbl treats the id as opaque.
   */
  artifactId?: ArtifactId;
  /**
   * Runtime model id; passed through to Session and into the spawn argv
   * by the adapter's buildSpawnCmd. null/omitted → no --model flag,
   * CC picks its default. Validation (allowlist, length) happens at the
   * HTTP route, not here.
   */
  model?: string | null;
  /**
   * Runtime to use for this session. When provided, overrides the registry's
   * defaultId. Rejected immediately if the id is not registered (e.g. operator
   * set a stage to codex but runtime.codex.enabled=false).
   */
  runtime?: RuntimeId;
  /**
   * Optional cohort/epic identity used for worktree + branch naming and
   * base-ref selection. Set by the dispatcher for cohort-bound sessions;
   * omitted for non-build stages, ad-hoc sessions, and direct POST /sessions
   * calls — those fall back to sid-based naming against HEAD.
   */
  worktreeIdentity?: EpicIdentity;
  // ── C.1 delegated-session fields ──────────────────────────────────────────
  /**
   * Rendered prompt to seed as the first turn. Seeded via session.writeInput()
   * right after the session becomes live so the agent starts immediately
   * without a separate /:sid/input call from the caller.
   */
  prompt?: string;
  /**
   * Tool names to pre-authorize via the session's allowlist before the first
   * turn is seeded. Applied before the prompt so tool hooks that fire on the
   * very first agent step are already authorized.
   */
  preAuthorizedTools?: string[];
  /** If true, enable yolo mode (auto-approve all tool calls) on the session. */
  yoloMode?: boolean;
  /** Declared output slots; stored alongside the callback for artifact validation. */
  outputSlots?: OutputSlot[];
  /** Outbound callback routing for the three C.2 / C.3 callbacks. */
  delegatedCallback?: DelegatedCallback;
}

/**
 * Workspace-layer event broadcast through the inbox stream. legit-biz-club
 * (the workspace layer) emits these via POST /inbox/workspace-events;
 * kbbl re-broadcasts them to inbox subscribers without interpreting the
 * payload. Adding new event kinds at the workspace layer requires no
 * kbbl change — `kind` is a free-form string and `payload` is a generic
 * record. Reconnect-with-snapshot does not replay workspace events;
 * legit-biz-club is the authoritative source for project state.
 */
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkspaceEventPayload = { readonly [key: string]: unknown };

export interface WorkspaceEvent {
  /** Event kind, e.g. "project_created", "convergence_round_started". */
  kind: string;
  /** Opaque project id from legit-biz-club. */
  projectId: ProjectId;
  /** Wall-clock ISO timestamp; emitter-supplied or defaulted on receipt. */
  ts: string;
  /** Event-specific payload. Treated as opaque by kbbl. */
  payload: WorkspaceEventPayload;
}

/**
 * /inbox delta shapes. `session_created` carries the full snapshot so clients
 * can add a row without a follow-up fetch; the later deltas only carry the
 * fields that actually change so a reconnect-with-snapshot is authoritative.
 *
 * `workspace_event` is the workspace layer's escape hatch — its payload
 * is opaque to kbbl and shaped by legit-biz-club. Workspace events are
 * NOT replayed on reconnect; subscribers that need authoritative project
 * state should query legit-biz-club directly.
 */
export type InboxDelta =
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_ended"; sid: string }
  | { type: "session_removed"; sid: string }
  | { type: "session_compacted"; sid: string; successor_sid: string }
  | { type: "compact_suggested"; sid: string; tokens: number; reason: string }
  | { type: "status_changed"; sid: string; status: SessionStatus }
  | { type: "pending_count_changed"; sid: string; count: number }
  | { type: "last_activity_changed"; sid: string; ts: string }
  | { type: "yolo_changed"; sid: string; yoloMode: boolean }
  | {
      type: "observed_model_changed";
      sid: string;
      initialObservedModel: string;
      observedModel: string;
    }
  | { type: "workspace_event"; event: WorkspaceEvent };

export interface InboxSnapshot {
  sessions: SessionSnapshot[];
}

type InboxSubscriber = (delta: InboxDelta) => void;

const LAST_ACTIVITY_THROTTLE_MS = 1000;

/**
 * Parse the depth encoded in a worktree branch name. Accepts both the legacy
 * `kbbl/<sid8>[-r<n>]` shape and the cohort `cohort/<slug>/<n>-<slug>[-r<n>]`
 * shape. Returns the `-r<n>` suffix depth, or 0 for bare branches. Warns and
 * returns 0 for any branch that matches neither shape — the prefix is
 * informational and validated elsewhere via worktreeBranch round-tripping.
 */
export function parseDepthFromBranch(branch: string): number {
  if (
    !/^(kbbl\/[0-9a-f]{8}|cohort\/[a-z0-9_]+\/\d+-[a-z0-9_]+)(?:-r\d+)?$/.test(branch)
  ) {
    console.error(
      `kbbl: parent branch ${branch} doesn't match kbbl/<sid8>[-r<n>] or cohort/<slug>/<n>-<slug>[-r<n>] — depth defaulting to 0`,
    );
    return 0;
  }
  const m = /-r(\d+)$/.exec(branch);
  return m ? Number.parseInt(m[1], 10) : 0;
}

interface DelegatedSessionConfig {
  callback: DelegatedCallback;
  outputSlots: OutputSlot[];
}

export class SessionManager {
  private readonly opts: SessionManagerOpts;
  private readonly sessions = new Map<string, Session>();
  /**
   * Delegated-session configs keyed by oakridgeSid. Populated in create()
   * when opts.delegatedCallback is set; cleaned up in onEnded. Provides
   * the callback to hook-route.ts for C.3 approval forwarding and to the
   * terminal-status reporter for C.2b.
   */
  private readonly delegatedConfigs = new Map<string, DelegatedSessionConfig>();
  /**
   * Idempotency index: stage_instance_id → oakridgeSid for delegated sessions.
   * Lets POST /sessions dedup a recovery re-POST — oakridge crashing after kbbl
   * created the session but before persisting the returned sid — back onto the
   * existing session instead of spawning a duplicate that would interleave
   * writes into the same transcript. Maintained symmetrically with
   * delegatedConfigs: transferred to the successor on compaction, removed on
   * terminal end.
   */
  private readonly delegatedByStageInstance = new Map<string, string>();

  private readonly inboxSubscribers = new Set<InboxSubscriber>();
  /**
   * Tracks the last time we actually emitted a last_activity_changed delta
   * for a given sid so we can throttle noisy emit() traffic down to ~1/sec
   * per session. Paired with pendingActivityTimers below so an event that
   * arrives mid-window still produces a trailing flush.
   */
  private readonly lastActivityFlushAt = new Map<string, number>();
  private readonly pendingActivityTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /**
   * Lazy cache of the archived-snapshot scan. Populated on first call to
   * listArchivedSnapshots() and reused thereafter — within a single
   * server run, archived sessions are immutable (in-memory ones are
   * filtered out, and a session never re-enters the archived set after
   * starting in memory). Only remove() invalidates an entry.
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
  private readonly pendingLifecycle = new Set<Promise<void>>();

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  /**
   * Returns the delegated callback for the given session, or null if the
   * session was not created via the C.1 delegated-execution contract.
   * Used by hook-route.ts to forward approval notifications (C.3).
   */
  getDelegatedCallback(oakridgeSid: string): DelegatedCallback | null {
    return this.delegatedConfigs.get(oakridgeSid)?.callback ?? null;
  }

  /**
   * Returns the live delegated session for the given oakridge stage_instance_id,
   * or null if none exists. Used by POST /sessions to make session creation
   * idempotent across oakridge crash-recovery re-POSTs.
   *
   * Ended sessions are filtered out explicitly: SessionManager intentionally
   * keeps ended sessions in `this.sessions` (so a client can still read the
   * failure via /:sid/events), so we cannot rely on the map dropping them. If
   * the index ever points at an ended sid, returning it would let POST /sessions
   * "dedup" onto a dead session instead of spawning fresh. onEnded already
   * removes the index entry, but enforcing "live" here keeps the contract
   * self-evident rather than dependent on that bookkeeping staying in sync.
   *
   * Self-healing: when the entry resolves to a missing or ended session it is
   * deleted from the index before returning null, so a stale key can't survive
   * a lookup and the index can't grow unbounded with dead mappings.
   */
  getDelegatedByStageInstance(stageInstanceId: string): Session | null {
    const sid = this.delegatedByStageInstance.get(stageInstanceId);
    if (sid === undefined) return null;
    const session = this.sessions.get(sid);
    if (session === undefined || session.status === "ended") {
      this.delegatedByStageInstance.delete(stageInstanceId);
      return null;
    }
    return session;
  }

  private async ensureWorktreesDirSafeForRepo(workdir: string): Promise<void> {
    const repoRoot = await resolveRepoTopLevel(workdir);
    if (!isPathInside(this.opts.worktreesDir, repoRoot)) return;

    const ignoreCheck = Bun.spawn({
      cmd: ["git", "-C", repoRoot, "check-ignore", "-q", this.opts.worktreesDir],
      stdout: "pipe",
      stderr: "pipe",
    });
    const ignoreCode = await ignoreCheck.exited;
    if (ignoreCode === 0) return;

    throw new Error(
      `worktreesDir ${this.opts.worktreesDir} is inside the repo at ${repoRoot} but is not gitignored by it`,
    );
  }

  async create(opts: CreateSessionOpts): Promise<Session> {
    // Reject unknown runtimes before touching disk or the session map so the
    // error is clearly attributable to a misconfigured stage override (e.g.
    // operator set runtime.stages.build = codex but runtime.codex.enabled=false).
    // On the legacy (no-registry) path opts.runtime is silently ignored so a
    // session can't be mislabeled with an id that was never used to spawn it.
    if (opts.runtime !== undefined && this.opts.registry) {
      if (!this.opts.registry.runtimes.has(opts.runtime)) {
        const registered = [...this.opts.registry.runtimes.keys()].join(", ");
        throw new Error(
          `kbbl: runtime "${opts.runtime}" is not registered — registered: ${registered}`,
        );
      }
    }
    const effectiveRuntimeId: RuntimeId =
      (opts.runtime !== undefined && this.opts.registry)
        ? opts.runtime
        : this.opts.registry?.defaultId ?? "claude-code";

    const oakridgeSid = newSessionId();
    // Server-side fallback so requests without a usable name still produce a
    // human-readable session name. `name` is optional in practice, and
    // resume/default client flows may omit it, so this can run for normal
    // client traffic as well as direct API hits.
    const name =
      opts.name && opts.name.trim() ? opts.name.trim() : `session-${oakridgeSid.slice(0, 8)}`;

    // Per-session worktree is mandatory: every spawn gets its own checkout +
    // branch off the workdir's HEAD, and spawn cwd is the worktree path.
    // Non-git workdirs are rejected — without a repo there's no way to
    // guarantee branch isolation, and the previous silent fallback let
    // sessions write directly into the operator's toplevel.
    if (!(await isGitRepo(opts.workdir))) {
      throw new NonGitWorkdirError(opts.workdir);
    }
    await this.ensureWorktreesDirSafeForRepo(opts.workdir);
    // On resume, opts.workdir is the parent's worktree path, NOT the
    // operator's original repo. Resolve both depth and the original
    // projectWorkdir from the parent so the new session's metadata points
    // at the original repo (for the PWA dual-label) instead of mistaking
    // the parent's worktree for the project root.
    let resumeDepth = 0;
    let inheritedProjectWorkdir: string | null = null;
    if (opts.parentOakridgeSid) {
      const meta = await this.lookupParentSessionMeta(opts.parentOakridgeSid);
      if (meta === null) {
        console.error(
          `kbbl: resume chain broken at ${opts.parentOakridgeSid} — defaulting depth to 1`,
        );
        resumeDepth = 1;
      } else {
        resumeDepth = meta.worktreeBranch
          ? parseDepthFromBranch(meta.worktreeBranch) + 1
          : 1;
        inheritedProjectWorkdir = meta.projectWorkdir;
      }
    }
    let worktreePath: string;
    let worktreeBranch: string;
    let worktreeBaseRef: string;
    try {
      const { worktreeIdentity } = opts;
      const created = await createWorktree({
        workdir: opts.workdir,
        worktreesRoot: this.opts.worktreesDir,
        oakridgeSid,
        resumeDepth,
        ...(worktreeIdentity
          ? {
              identity: {
                branchName: `cohort/${worktreeIdentity.epicSlug}/${worktreeIdentity.cohortSlug}`,
                worktreeSubdir: `${worktreeIdentity.epicSlug}/${worktreeIdentity.cohortSlug}`,
              },
              baseRef: `origin/${worktreeIdentity.epicBranch}`,
            }
          : {}),
      });
      worktreePath = created.worktreePath;
      worktreeBranch = created.worktreeBranch;
      worktreeBaseRef = created.worktreeBaseRef;
    } catch (err) {
      if (err instanceof WorktreeCreateError) {
        throw new Error(
          `worktree create failed: ${err.message}\n${err.stderr}`,
        );
      }
      throw err;
    }
    // Fresh session: opts.workdir IS the operator workdir.
    // Resume: inherit parent.projectWorkdir (which already points at the
    // original repo for both Phase-1 and pre-Phase-1 parents).
    const projectWorkdir = inheritedProjectWorkdir ?? opts.workdir;
    const effectiveWorkdir = worktreePath;

    // Roll back the worktree if Session construction throws (e.g. artifactId
    // length validation). The worktree exists on disk but no Session, no map
    // entry, no broadcast — leaving it would orphan a branch + dir that the
    // operator never asked for. Spawn failure (after this point) is a
    // different case: the Session is already in the map and the operator
    // can see/clean up; that's covered by the existing "failed sessions
    // linger" behavior + Phase 2 reconcile.
    let session: Session;
    try {
      session = new Session({
      oakridgeSid,
      workdir: effectiveWorkdir,
      name,
      sessionsDir: this.opts.sessionsDir,
      runtimeId: effectiveRuntimeId,
      parentCcSid: opts.parentCcSid,
      parentOakridgeSid: opts.parentOakridgeSid,
      artifactId: opts.artifactId,
      worktreePath,
      worktreeBranch,
      worktreeBaseRef,
      projectWorkdir,
      model: opts.model ?? null,
      classifyEvent: this.opts.classifyEvent,
      // Prefer the registry runtime's nonPersistedEventTypes so a caller that
      // only wires `registry` (without the legacy opts) still gets the right
      // high-volume event suppression (e.g. CC stream_event).
      nonPersistedEventTypes:
        this.opts.registry?.runtimes.get(effectiveRuntimeId)?.nonPersistedEventTypes
        ?? this.opts.nonPersistedEventTypes,
      callbacks: {
        onRuntimeSessionObserved: (s, runtimeSid) => {
          this.opts.onRuntimeSessionObserved?.(s, runtimeSid);
        },
        onEnded: (s) => {
          // C.2b: report terminal status for delegated sessions unless this
          // was a compaction (the successor session continues the work).
          const delegatedCfg = this.delegatedConfigs.get(s.oakridgeSid);
          if (delegatedCfg) {
            this.delegatedConfigs.delete(s.oakridgeSid);
            // Drop the idempotency index entry unconditionally, then re-point it
            // at the successor below if this was a compaction — mirroring the
            // delegatedConfigs handling so the two stay consistent.
            const stageInstanceId = delegatedCfg.callback.stage_instance_id;
            this.delegatedByStageInstance.delete(stageInstanceId);
            if (s.endReason === "compacted" && s.successorSid) {
              // Transfer to successor so C.2b/C.3 keep working after compact.
              this.delegatedConfigs.set(s.successorSid, delegatedCfg);
              this.delegatedByStageInstance.set(stageInstanceId, s.successorSid);
            } else if (s.endReason !== "compacted") {
              void reportTerminalStatus(delegatedCfg.callback, "done", s.oakridgeSid);
            }
          }
          this.opts.onRuntimeSessionEnded?.(s);
          this.clearActivityTimer(s.oakridgeSid);
          this.broadcastDelta({ type: "session_ended", sid: s.oakridgeSid });
        },
        onStatusChanged: (s, status) => {
          this.broadcastDelta({
            type: "status_changed",
            sid: s.oakridgeSid,
            status,
          });
        },
        onPendingCountChanged: (s, count) => {
          this.broadcastDelta({
            type: "pending_count_changed",
            sid: s.oakridgeSid,
            count,
          });
        },
        onLastActivityChanged: (s, ts) => {
          this.scheduleActivityDelta(s.oakridgeSid, ts);
        },
        onYoloChanged: (s, yoloMode) => {
          this.broadcastDelta({
            type: "yolo_changed",
            sid: s.oakridgeSid,
            yoloMode,
          });
        },
        onRuntimeModelObserved: (s, observedModel) => {
          this.broadcastDelta({
            type: "observed_model_changed",
            sid: s.oakridgeSid,
            initialObservedModel: s.initialObservedModel ?? observedModel,
            observedModel,
          });
        },
      },
      });
    } catch (ctorErr) {
      if (worktreePath && worktreeBranch) {
        // Best-effort cleanup; log on failure rather than masking ctorErr.
        await removeWorktree({
          workdir: opts.workdir,
          worktreePath,
          worktreeBranch,
        }).catch((e) => {
          console.error(
            `kbbl: worktree rollback after ctor failure failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
      }
      throw ctorErr;
    }
    // Register in the live map before spawn so /hook/approval can find the
    // session as soon as system/init arrives. If spawn throws, we keep it
    // in the map (as ended) so a client that POSTed /sessions can still
    // read the failure via /:sid/events. Reaping of ended sessions is a
    // future PR; for now they accumulate, bounded by server lifetime.
    this.sessions.set(session.oakridgeSid, session);
    // Compactor: schedules /compact firings based on session-token pressure.
    const compactor = new Compactor(this.opts.config.compact, {
      onSuggested: (reason, sessionTokens) => {
        session
          .emit("compact_suggested", {
            reason: reason.kind,
            session_tokens: sessionTokens,
          })
          .catch((err) => {
            console.error(
              `kbbl: compact_suggested emit failed for ${session.oakridgeSid}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        this.broadcastDelta({
          type: "compact_suggested",
          sid: session.oakridgeSid,
          tokens: sessionTokens,
          reason: reason.kind,
        });
      },
      onFire: async (reason, sessionTokens) => {
        await this.runCompact(session.oakridgeSid, reason, sessionTokens);
      },
    });
    session.attachCompactor(compactor);
    // Broadcast session_created with the starting-state snapshot before we
    // await spawn(). That way /inbox subscribers see the new row appear
    // immediately and then receive status/pending/activity deltas as the
    // subprocess comes up.
    this.broadcastDelta({ type: "session_created", session: session.snapshot() });

    // Spawn: use the registry path (AgentRuntime.spawn + attachRuntime) when
    // a registry is configured; fall back to the legacy buildSpawnCmd path.
    const registry = this.opts.registry;
    if (registry) {
      const runtimeId: RuntimeId = session.runtimeId;
      const runtime = registry.runtimes.get(runtimeId);
      if (!runtime) {
        throw new Error(`kbbl: no runtime registered for id "${runtimeId}"`);
      }
      const handle = await runtime.spawn({
        workingDirectory: session.workdir,
        runtimeSpecific: {
          model: session.model,
          parentCcSid: session.parentCcSid,
          parentOakridgeSid: session.parentOakridgeSid,
          oakridgeSid: session.oakridgeSid,
          projectWorkdir: session.projectWorkdir,
        },
      });
      await session.attachRuntime(runtime, handle);
    } else if (this.opts.buildSpawnCmd) {
      await session.spawn(await this.opts.buildSpawnCmd(session));
    } else {
      throw new Error(
        "kbbl: SessionManager requires either opts.registry or opts.buildSpawnCmd",
      );
    }

    // ── C.1 delegated-session post-spawn wiring ──────────────────────────
    // Stash the config first so the hook handler can find the callback as
    // soon as the first tool call arrives (before we even send the prompt).
    //
    // Defensive precondition: never register delegated mappings for an already-
    // ended session — onEnded keys its cleanup off delegatedConfigs, so a mapping
    // inserted after onEnded ran would be stale forever. Today this can't trigger
    // via the registry path: attachRuntime resolves with status="live" and runs
    // the event loop detached (session.ts _wireAttached), so onEnded cannot
    // preempt this synchronous block. The guard encodes the invariant cheaply in
    // case that ordering ever changes; getDelegatedByStageInstance() self-heals
    // any stale entry that slips through from another path.
    if (opts.delegatedCallback && session.status !== "ended") {
      this.delegatedConfigs.set(session.oakridgeSid, {
        callback: opts.delegatedCallback,
        outputSlots: opts.outputSlots ?? [],
      });
      this.delegatedByStageInstance.set(
        opts.delegatedCallback.stage_instance_id,
        session.oakridgeSid,
      );
    }
    // Pre-authorize tools before seeding the prompt so hooks that fire on
    // the first agent step see the allowlist already applied.
    if (opts.preAuthorizedTools && opts.preAuthorizedTools.length > 0) {
      for (const tool of opts.preAuthorizedTools) {
        try {
          await session.allowlistTool(tool);
        } catch (err) {
          console.error(
            `kbbl: failed to allowlist tool "${tool}" for ${session.oakridgeSid}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    if (opts.yoloMode === true) {
      try {
        await session.setYolo(true);
      } catch (err) {
        console.error(
          `kbbl: failed to set yolo for ${session.oakridgeSid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Seed the first turn with the rendered prompt so the agent starts
    // immediately without a separate /:sid/input call.
    if (opts.prompt) {
      try {
        await session.writeInput(opts.prompt);
      } catch (err) {
        console.error(
          `kbbl: failed to seed initial prompt for ${session.oakridgeSid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return session;
  }

  /**
   * Relaunch a live-but-orphaned row after a server restart (A.2 recovery).
   * Distinct from create() (new row, new ids) and the compaction successor
   * path (new id, new row). Recovery continues in the SAME row: same
   * oakridgeSid, same currentCcSid, appending to the existing JSONL and the
   * same CC transcript.
   *
   * Flow:
   *  1. Guard: refuse if the session is already live in memory (PTY held).
   *  2. Load the archived snapshot from the JSONL to recover session metadata.
   *  3. Resolve the CC session id via runtime.resolveResumeRef.
   *  4. Construct a fresh Session (same oakridgeSid → same JSONL file, append).
   *  5. Spawn with --resume <ccSid> and NO --fork-session (continue-in-place).
   *  6. Wire the fresh PTY to the session via attachRuntime.
   *
   * The single-writer supervisor in the adapter (index.ts) guards the ccSid
   * map before opening the new PTY, ensuring at most one live claude process
   * per CC session id within the running server. Accepted loss on recovery:
   * only the in-flight turn at the instant of the prior crash; completed
   * history is fully recovered from the transcript.
   *
   * Requires opts.registry; throws for the legacy buildSpawnCmd-only path.
   */
  async relaunch(oakridgeSid: string): Promise<Session> {
    // Guard: refuse if any active subprocess is attached — "live", "starting"
    // (mid-spawn), and "compacting" (PTY active) all mean a process is running.
    // Only "ended" is safe to relaunch over.
    const existing = this.sessions.get(oakridgeSid);
    if (existing && existing.status !== "ended") {
      throw new Error(
        `kbbl: relaunch refused for ${oakridgeSid} — session is not ended (status: ${existing.status})`,
      );
    }

    if (!this.opts.registry) {
      throw new Error(
        "kbbl: relaunch requires opts.registry — the legacy buildSpawnCmd path does not support recovery",
      );
    }

    const jsonlPath = join(this.opts.sessionsDir, `${oakridgeSid}.jsonl`);
    const snap = await loadArchivedSnapshot(
      oakridgeSid,
      jsonlPath,
      this.opts.registry,
    );
    if (!snap) {
      throw new Error(
        `kbbl: relaunch failed for ${oakridgeSid} — archived snapshot missing or empty`,
      );
    }

    // Guard: never revive a compacted row — its successor is the live branch.
    if (snap.endReason === "compacted") {
      throw new Error(
        `kbbl: relaunch refused for ${oakridgeSid} — session was compacted (successor: ${snap.successorSid ?? "unknown"}); relaunch the successor instead`,
      );
    }

    const runtimeId = snap.runtimeId;
    const runtime = this.opts.registry.runtimes.get(runtimeId);
    if (!runtime) {
      throw new Error(
        `kbbl: relaunch failed for ${oakridgeSid} — runtime "${runtimeId}" is not registered`,
      );
    }

    const ref = await runtime.resolveResumeRef(this.opts.sessionsDir, oakridgeSid);
    if (ref.kind !== "ok") {
      throw new Error(
        `kbbl: relaunch failed for ${oakridgeSid} — cannot resolve CC session id: ${ref.kind}`,
      );
    }
    const ccSid = ref.runtimeSid;

    // Seed nextId past the highest id already written so appended recovery
    // events never collide with pre-restart ids. SSE sentUpTo dedup drops
    // events with id <= sentUpTo; without this, a reconnecting client with a
    // stale sentUpTo would silently lose all recovery events.
    const startingNextId = (await readMaxEventId(jsonlPath)) + 1;

    // Construct a fresh Session with the same oakridgeSid. The JSONL FileSink
    // opens in append mode so recovery events are added after the original
    // history without overwriting it.
    const session = new Session({
      oakridgeSid,
      workdir: snap.workdir,
      name: snap.name,
      sessionsDir: this.opts.sessionsDir,
      runtimeId,
      parentCcSid: snap.parentCcSid ?? undefined,
      parentOakridgeSid: snap.parentOakridgeSid ?? undefined,
      artifactId: snap.artifactId ?? undefined,
      model: snap.model,
      createdAt: snap.createdAt,
      startingNextId,
      worktreePath: snap.worktreePath,
      worktreeBranch: snap.worktreeBranch,
      worktreeBaseRef: snap.worktreeBaseRef,
      projectWorkdir: snap.projectWorkdir,
      nonPersistedEventTypes:
        runtime.nonPersistedEventTypes ?? this.opts.nonPersistedEventTypes,
      callbacks: {
        onRuntimeSessionObserved: (s, runtimeSid) => {
          this.opts.onRuntimeSessionObserved?.(s, runtimeSid);
        },
        onEnded: (s) => {
          this.opts.onRuntimeSessionEnded?.(s);
          this.clearActivityTimer(s.oakridgeSid);
          this.broadcastDelta({ type: "session_ended", sid: s.oakridgeSid });
        },
        onStatusChanged: (s, status) => {
          this.broadcastDelta({
            type: "status_changed",
            sid: s.oakridgeSid,
            status,
          });
        },
        onPendingCountChanged: (s, count) => {
          this.broadcastDelta({
            type: "pending_count_changed",
            sid: s.oakridgeSid,
            count,
          });
        },
        onLastActivityChanged: (s, ts) => {
          this.scheduleActivityDelta(s.oakridgeSid, ts);
        },
        onYoloChanged: (s, yoloMode) => {
          this.broadcastDelta({
            type: "yolo_changed",
            sid: s.oakridgeSid,
            yoloMode,
          });
        },
        onRuntimeModelObserved: (s, observedModel) => {
          this.broadcastDelta({
            type: "observed_model_changed",
            sid: s.oakridgeSid,
            initialObservedModel: s.initialObservedModel ?? observedModel,
            observedModel,
          });
        },
      },
    });

    this.sessions.set(session.oakridgeSid, session);

    const compactor = new Compactor(this.opts.config.compact, {
      onSuggested: (reason, sessionTokens) => {
        session
          .emit("compact_suggested", {
            reason: reason.kind,
            session_tokens: sessionTokens,
          })
          .catch((err) => {
            console.error(
              `kbbl: compact_suggested emit failed for ${session.oakridgeSid}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        this.broadcastDelta({
          type: "compact_suggested",
          sid: session.oakridgeSid,
          tokens: sessionTokens,
          reason: reason.kind,
        });
      },
      onFire: async (reason, sessionTokens) => {
        await this.runCompact(session.oakridgeSid, reason, sessionTokens);
      },
    });
    session.attachCompactor(compactor);

    this.broadcastDelta({ type: "session_created", session: session.snapshot() });

    const handle = await runtime.spawn({
      workingDirectory: session.workdir,
      runtimeSpecific: {
        resumeCcSid: ccSid,
        oakridgeSid: session.oakridgeSid,
        model: session.model,
        projectWorkdir: session.projectWorkdir,
      },
    });
    await session.attachRuntime(runtime, handle);

    return session;
  }

  async drainLifecycle(): Promise<void> {
    await Promise.allSettled([...this.pendingLifecycle]);
  }

  /**
   * Look up `worktreeBranch` + `projectWorkdir` from a parent session's
   * `session_started` event. Both are consumed by create() at resume time:
   *   - branch suffix → next resume depth (`kbbl/<sid8>-r<n>`).
   *   - projectWorkdir → the original repo, propagated to the child so its
   *     PWA dual-label and worktree-cleanup point at the right place
   *     instead of treating the parent's worktree as the project root.
   *
   * Lookup precedence: in-memory map (cheap, authoritative for live/ended
   * sessions) → JSONL session_started (for parents whose Session is no
   * longer in memory after restart). Returns null if the parent is unknown
   * to both sources, its JSONL is unreadable, or its JSONL has no usable
   * session_started event — caller treats null as a broken chain and logs.
   * Even pre-Phase-1 sessions emitted session_started, so a readable JSONL
   * without one is genuinely broken, not just old.
   *
   * For a pre-Phase-1 parent the JSONL stored only `workdir` (which IS the
   * operator's repo) and no worktreeBranch. projectWorkdir falls back to
   * `workdir` so a child resuming off such a parent still gets a usable
   * repo root, and worktreeBranch=null tells the caller to treat resume
   * depth as 1.
   */
  private async lookupParentSessionMeta(
    parentOakridgeSid: string,
  ): Promise<{
    worktreeBranch: string | null;
    projectWorkdir: string | null;
  } | null> {
    const live = this.sessions.get(parentOakridgeSid);
    if (live) {
      return {
        worktreeBranch: live.worktreeBranch,
        projectWorkdir: live.projectWorkdir ?? live.workdir,
      };
    }
    const jsonlPath = join(this.opts.sessionsDir, `${parentOakridgeSid}.jsonl`);
    let contents: string;
    try {
      contents = await readJsonlOrEmpty(jsonlPath);
    } catch {
      return null;
    }
    if (!contents) return null;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      let evt: EnvelopeEvent;
      try {
        evt = JSON.parse(line) as EnvelopeEvent;
      } catch {
        continue;
      }
      if (evt.type !== "session_started") continue;
      const payload = archivedSessionStartedPayload(evt.payload);
      const worktreeBranch =
        typeof payload.worktreeBranch === "string"
          ? payload.worktreeBranch
          : null;
      // Phase-1 JSONLs persist projectWorkdir directly. Pre-Phase-1 only
      // has `workdir` (which IS the original repo), so fall back to that.
      const projectWorkdir =
        typeof payload.projectWorkdir === "string"
          ? payload.projectWorkdir
          : typeof payload.workdir === "string"
            ? payload.workdir
            : null;
      return { worktreeBranch, projectWorkdir };
    }
    return null;
  }

  get(oakridgeSid: string): Session | undefined {
    return this.sessions.get(oakridgeSid);
  }

  /**
   * Look up a session by the runtime's internal session id (e.g. CC's
   * session_id from system/init). Delegates to opts.lookupByCcSid if
   * provided; the CC adapter owns the ccSid→oakridgeSid map and wires it
   * via that callback. Returns undefined if no callback is configured.
   */
  getByCcSid(ccSid: string): Session | undefined {
    return this.opts.lookupByCcSid?.(ccSid);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Live sessions only. Ended sessions linger in the map so clients can
   * still read archived events via /:sid/events, but callers that only
   * care about actionable state (pending approvals, input routing) want
   * this filtered view.
   */
  listLive(): Session[] {
    return [...this.sessions.values()].filter((s) => s.status === "live");
  }

  /**
   * Sessions tagged with the given artifactId — the workspace layer's
   * primary query for enumerating an ensemble. Includes every in-memory
   * session regardless of status (starting, live, or ended); archived
   * (on-disk) sessions are not consulted. Callers that need the
   * archived merge should pull listArchivedSnapshots() separately and
   * filter by ``artifactId`` client-side, the same pattern GET
   * /sessions uses for include=archived.
   *
   * Input is trimmed to match the normalization Session.artifactId
   * applies on the write side; whitespace differences in the query
   * would otherwise silently miss matches. Empty-after-trim returns
   * an empty list rather than matching every session whose artifactId
   * happens to be null (which "" === null would never do anyway, but
   * the guard makes the intent explicit).
   */
  listByArtifact(artifactId: ArtifactId): Session[] {
    const normalized = artifactId.trim() as ArtifactId;
    if (!normalized) return [];
    return [...this.sessions.values()].filter(
      (s) => s.artifactId === normalized,
    );
  }

  listSnapshots(): SessionSnapshot[] {
    return this.list().map((s) => s.snapshot());
  }

  /**
   * Returns snapshots of sessions whose JSONL exists on disk but which
   * aren't currently in memory — i.e. sessions from prior server runs that
   * completed before restart. Live/ended-in-memory sessions are filtered
   * out here so the caller can merge these with listSnapshots() without
   * duplicates.
   *
   * First call scans the sessions directory and parses each JSONL; result
   * is cached for the lifetime of the server process. Subsequent calls
   * return cached snapshots without I/O. Only remove() can invalidate an
   * entry. With ~20 archived sessions, this cuts a 100ms+ /sessions call
   * to <1ms after the first hit, which matters for PWA cold start where
   * multiple tabs all fetch the list at once.
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
    // Filter on read so an entry whose sid has since started in memory
    // (extremely rare — would require a sid collision or a server-on-server
    // scenario) doesn't escape the cache and confuse callers.
    const out: SessionSnapshot[] = [];
    cache.forEach((snap, sid) => {
      if (!this.sessions.has(sid)) out.push(snap);
    });
    return out;
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
      if (this.sessions.has(sid)) continue;
      const jsonlPath = join(this.opts.sessionsDir, name);
      const snap = await loadArchivedSnapshot(sid, jsonlPath, this.opts.registry);
      if (snap) cache.set(sid, snap);
    }
    this.archivedSnapshotCache = cache;
  }

  /**
   * Returns the single live session if exactly one exists, otherwise null.
   * Used by the legacy (non-sid-prefixed) HTTP routes so the existing PWA
   * keeps working through the refactor. At zero or 2+ live sessions the
   * legacy routes return 409; they're a bridge, not a long-term shape.
   */
  getSingleLive(): Session | null {
    let found: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.status !== "live") continue;
      if (found) return null;
      found = s;
    }
    return found;
  }

  /**
   * Aborts a specific session and awaits its exit. Returns the subprocess
   * exit code (or -1 if unknown).
   */
  async end(oakridgeSid: string): Promise<number> {
    const session = this.sessions.get(oakridgeSid);
    if (!session) return -1;
    return session.abort();
  }

  /**
   * Hard-deletes a session: aborts it if live, drops it from the in-memory
   * map, removes its JSONL from disk, and broadcasts session_removed.
   * Works on archived-only sids too (not in memory) — those just delete the
   * JSONL. Returns true if anything was removed (file or map entry), false
   * if the sid was unknown to both. Throws RemoveFailedError if unlink
   * fails for any reason other than ENOENT, so the route handler can
   * return 5xx instead of advertising a successful purge while removal
   * of the transcript could not be confirmed (an EACCES on the parent
   * directory, for example, fails before we'd know whether the file
   * existed).
   *
   * Order of operations:
   *  1. Wait for any in-flight archived scan so we operate on a consistent
   *     cache state (otherwise a scan finishing after our cache.delete()
   *     could resurrect this sid).
   *  2. Abort the live subprocess if any (drains the jsonlWriter so the
   *     unlink doesn't race with an open FD).
   *  3. Unlink the JSONL. ENOENT = already gone = success. Any other error
   *     is propagated; the in-memory map entry stays put so a retry can
   *     finish the job.
   *  4. After unlink success (or ENOENT), evict from cache + drop map
   *     entry + broadcast. These in-memory removals are part of the
   *     "anything was removed" return contract; this step just does not
   *     run if unlink fails for a non-ENOENT reason (we throw before
   *     reaching it).
   */
  async remove(oakridgeSid: string): Promise<boolean> {
    // Trigger the archived scan up front (if it hasn't run yet and isn't
    // already in flight) but DON'T await it here — the scan needs to be
    // resolved before we touch the cache, but we don't want it blocking
    // the live-session abort below. Without this trigger, a
    // listArchivedSnapshots() call landing mid-remove could start a fresh
    // scan that reads the JSONL we're about to unlink and writes it back
    // into the cache after our cache.delete() — resurrecting a purged
    // sid. Kicking it off here ensures any later list call joins the same
    // promise instead of starting a new one.
    if (this.archivedSnapshotCache === null && this.archivedScanPromise === null) {
      this.archivedScanPromise = this.populateArchivedCache().finally(() => {
        this.archivedScanPromise = null;
      });
    }
    // Snapshot worktree info BEFORE eviction. The in-memory Session is the
    // cheap source; archived JSONL is the fallback. We need all three
    // (workdir, worktreePath, worktreeBranch) to drive `git worktree
    // remove` against the original repo. Pre-Phase-1 sessions have null
    // worktreePath and skip cleanup entirely.
    const worktreeInfo = await this.lookupWorktreeForRemove(oakridgeSid);
    const session = this.sessions.get(oakridgeSid);
    if (session) {
      // abort() is idempotent on already-ended sessions, so this is safe
      // for both live and ended map entries. Run BEFORE the scan-await so
      // a Remove tap on a live session kills the subprocess immediately
      // instead of waiting ~130ms for the cold archived scan to finish.
      // The scan still runs in parallel; we await it below.
      try {
        await session.abort();
      } catch (err) {
        console.error(
          `kbbl: abort during remove failed for ${oakridgeSid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Now resolve the scan promise (which has been running in parallel
    // with the abort above). After this we know the cache is either
    // populated or definitively failed to populate, so the cache.delete()
    // below can't be undone by a late-completing scan.
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
    const jsonlPath = join(this.opts.sessionsDir, `${oakridgeSid}.jsonl`);
    // Distinct from "unlink resolved without throwing": only true when
    // unlink actually deleted a file (ENOENT does NOT set this). Seeded
    // into `removed` below so any real file deletion counts as removal,
    // even when the sid wasn't in the live map AND wasn't in the cache
    // (e.g. an archived JSONL that loadArchivedSnapshot() skipped because
    // it was empty/malformed). ENOENT keeps it false so a typo'd sid
    // returns `removed: false` rather than a false-positive 200.
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
        // Real failure (EACCES, EBUSY, EIO, ...). Leave the in-memory map
        // entry alone — the subprocess is already dead from the abort
        // above, but the operator can still see a stuck row and retry.
        // Do NOT broadcast session_removed; do NOT evict from cache.
        throw new RemoveFailedError(oakridgeSid, jsonlPath, err);
      }
      // ENOENT — file was already gone. Resolved without throwing, but
      // we did not actually delete anything; unlinkDeletedFile stays false.
    }
    // Past this point: unlink succeeded OR ENOENT (file already absent).
    // Reflect the new state in our in-memory bookkeeping.
    let removed = unlinkDeletedFile;
    if (session) {
      this.sessions.delete(oakridgeSid);
      this.clearActivityTimer(oakridgeSid);
      removed = true;
    }
    if (this.archivedSnapshotCache?.delete(oakridgeSid)) removed = true;
    if (removed) {
      this.broadcastDelta({ type: "session_removed", sid: oakridgeSid });
    }
    // Best-effort worktree cleanup AFTER the JSONL is gone. JSONL is the
    // source of truth — if we removed the worktree first and the unlink
    // then failed, the next startup would see a JSONL pointing at a dead
    // worktree and `resolveResumeParent` would 400 on resume. With this
    // ordering, a worktree-remove failure leaves an orphan that Phase 2's
    // reconcile can clean up; no JSONL lies. Skipped entirely for
    // pre-Phase-1 sessions (worktreeInfo === null).
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
   * shell out `git worktree remove`, or null if the session predates
   * Phase 1 / has no worktree. Live in-memory sessions are the cheap
   * source; archived ones come from JSONL via the cache or a direct read.
   */
  private async lookupWorktreeForRemove(
    oakridgeSid: string,
  ): Promise<{ workdir: string; worktreePath: string; worktreeBranch: string } | null> {
    const live = this.sessions.get(oakridgeSid);
    if (live) {
      if (
        live.worktreePath === null ||
        live.worktreeBranch === null ||
        live.projectWorkdir === null
      ) {
        return null;
      }
      return {
        workdir: live.projectWorkdir,
        worktreePath: live.worktreePath,
        worktreeBranch: live.worktreeBranch,
      };
    }
    // Archived: prefer the cache so we don't re-read the JSONL we may have
    // already parsed during populateArchivedCache. Fall back to a fresh
    // read (cache unpopulated, or this sid was filtered out for being
    // empty/malformed at scan time).
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
    const snap = await loadArchivedSnapshot(oakridgeSid, jsonlPath, this.opts.registry);
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

  /**
   * Aborts every session in the map (live, starting, or already ended —
   * iterating all is intentional so a session mid-spawn is waited on, not
   * skipped). Ended sessions short-circuit cheaply in Session.abort().
   * Returns the highest exit code across all sessions, or 0 if all exited
   * cleanly.
   */
  async endAll(): Promise<number> {
    const exits = await Promise.all(
      [...this.sessions.values()].map((s) => {
        s.markEndReason("user_closed");
        return s.abort().catch(() => 1);
      }),
    );
    return Math.max(0, ...exits);
  }

  requestManualCompact(sid: string): "ok" | "not_found" | "not_live" {
    const session = this.sessions.get(sid);
    if (!session) return "not_found";
    if (session.status !== "live") return "not_live";
    const compactor = session.compactor;
    if (!compactor) return "not_live";
    void compactor.forceFire({ kind: "manual" });
    return "ok";
  }

  /**
   * Run /compact on a live session: prompt CC for a handoff doc, parse +
   * persist, spawn a successor session seeded with the handoff markdown,
   * then mark the old session compacted. Invoked by
   * Compactor.onFire (auto) or by the operator via a future API route
   * (manual). Failure modes per cached-crusader-plan.md §1.4:
   *
   *  - timeout awaiting CC's compact response → compact_failed{phase:timeout}
   *  - parse error → defaults; successor still gets raw_markdown
   *  - successor spawn throws → compact_completed{null sid} +
   *    compact_succeeded_but_resume_failed; old session stays live
   *
   * Status transitions are guarded: failure paths revert "compacting" →
   * "live" only when the session is still in "compacting" state. If the
   * subprocess exited mid-compact and finalize() already moved status to
   * "ended", we don't resurrect it. The outer try/finally guarantees
   * recordSuccess/recordFailure runs even on unexpected throws.
   */
  async runCompact(
    sid: string,
    reason: CompactReason,
    sessionTokens: number = 0,
  ): Promise<void> {
    const oldSession = this.sessions.get(sid);
    if (!oldSession || oldSession.status !== "live") return;

    const compactor = oldSession.compactor;
    if (!compactor) {
      console.error(
        `kbbl: runCompact called on session ${sid} with no compactor attached`,
      );
      return;
    }

    // Transition status BEFORE the prompt write so subscribers see
    // "compacting" before the COMPACT_PROMPT line lands in JSONL.
    // markCompacting validates the current status is "live" — a no-op
    // otherwise — so we can't accidentally resurrect an ended session.
    oldSession.markCompacting();

    let succeeded = false;
    try {
      await oldSession.emit("compact_fired", {
        reason,
        session_tokens: sessionTokens,
      });

      const compactTimeoutMs =
        this.opts.config.compact.compact_call_timeout_seconds * 1000;

      const md = await this.awaitCompactResult(oldSession, compactTimeoutMs);
      if (md === null) {
        await oldSession.emit("compact_failed", { phase: "timeout" });
        return;
      }

      const handoff = parseHandoffMarkdown(md, {
        from_session_id: oldSession.oakridgeSid,
        produced_at: new Date().toISOString(),
      });

      // Persist the raw markdown to disk so the PWA (Phase 1.8 follow-up
      // PR) can render it later. Directory is created at server startup;
      // first-compaction recursive mkdir is belt-and-suspenders.
      const handoffPath = join(
        this.opts.handoffsDir,
        `${oldSession.oakridgeSid}.md`,
      );
      try {
        await mkdir(this.opts.handoffsDir, { recursive: true });
        await writeFile(handoffPath, handoff.raw_markdown, "utf8");
      } catch (err) {
        console.error(
          `kbbl: failed to persist handoff for ${oldSession.oakridgeSid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Spawn the successor BEFORE emitting compact_completed so the
      // event records the actual successor_sid on the success path. On
      // spawn failure, emit compact_completed with successor_sid: null
      // followed by compact_succeeded_but_resume_failed — the JSONL
      // preserves the "completed-then-resume-failed" trail.
      let successor: Session;
      try {
        successor = await this.create({
          workdir: oldSession.workdir,
          parentCcSid: oldSession.currentCcSid ?? undefined,
          parentOakridgeSid: oldSession.oakridgeSid,
          model: oldSession.model ?? null,
        });
      } catch (err) {
        await oldSession.emit("compact_completed", {
          handoff_doc: handoff,
          successor_sid: null,
        });
        await oldSession.emit("compact_succeeded_but_resume_failed", {
          handoff_doc: handoff,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Deliver the handoff to the successor as a hard requirement of
      // compaction. If delivery fails (successor died on spawn, write
      // races a finalize, etc.), end the half-broken successor and
      // treat the whole compaction as a resume failure — the operator
      // gets a clear signal instead of a successor session that exists
      // but never received its context.
      try {
        await successor.writeInput(handoff.raw_markdown, { internal: true });
      } catch (err) {
        await successor.abort().catch(() => {
          // best-effort; the successor's own finalize will clean it up
        });
        await oldSession.emit("compact_completed", {
          handoff_doc: handoff,
          successor_sid: null,
        });
        await oldSession.emit("compact_succeeded_but_resume_failed", {
          handoff_doc: handoff,
          error: `handoff delivery failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        return;
      }

      await oldSession.emit("compact_completed", {
        handoff_doc: handoff,
        successor_sid: successor.oakridgeSid,
      });

      // Mark + abort. Awaited so recordSuccess only fires after the
      // subprocess teardown resolves — a rejected abort can't slip past us
      // into success.
      oldSession.markEndReason("compacted");
      // markCompactedTo BEFORE abort so the snapshot fired by the
      // session_ended delta (broadcast inside abort → finalize → onEnded)
      // already carries successorSid — the PWA doesn't have to wait for
      // the trailing session_compacted delta to render the "→ session NNN"
      // link.
      oldSession.markCompactedTo(successor.oakridgeSid);
      await oldSession.abort();

      this.broadcastDelta({
        type: "session_compacted",
        sid: oldSession.oakridgeSid,
        successor_sid: successor.oakridgeSid,
      });

      succeeded = true;
    } catch (err) {
      // Defensive: writeInput / emit / parseHandoffMarkdown / etc. could
      // throw something we didn't model above. Log and let finally clean
      // up state. Without this, an unexpected throw would leave the
      // session stuck in "compacting" with no recordFailure.
      console.error(
        `kbbl: runCompact unexpected error for ${oldSession.oakridgeSid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      if (succeeded) {
        compactor.recordSuccess();
      } else {
        compactor.recordFailure();
        // markLive only flips when current status is "compacting"; if
        // the subprocess exited mid-compact and finalize() already moved
        // status to "ended", this is a no-op so the closed JSONL writer
        // doesn't get resurrected.
        oldSession.markLive();
      }
    }
  }

  /**
   * Race the next session.emit("result", ...) against the timeout. On
   * resolve, returns the markdown extracted from CC's result content.
   * On timeout, returns null.
   *
   * Correlation: emit a "compact_prompt_sent" marker and capture its
   * monotonic event id. The subscriber only resolves on result events
   * with id > marker.id, so a stale `result` event already in the
   * emit queue from before subscription can't be misread as the
   * compaction handoff response. The marker also serves as a
   * breadcrumb in JSONL replay.
   */
  private async awaitCompactResult(
    session: Session,
    timeoutMs: number,
  ): Promise<string | null> {
    let unsubscribe: (() => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      // Emit the marker BEFORE subscribing so any result event still
      // draining through emitQueue from earlier activity has already
      // been delivered (or has a smaller id than markerId). The
      // subscriber then only sees events with id strictly greater than
      // the marker — i.e. the COMPACT_PROMPT response and anything
      // emitted afterward.
      const marker = await session.emit("compact_prompt_sent", {});
      const markerId = marker.id;
      const got = new Promise<string | null>((resolve) => {
        unsubscribe = session.subscribe((evt) => {
          if (evt.id <= markerId) return;
          if (evt.type !== "result") return;
          const md = extractCompactMarkdown(evt.payload);
          if (md === null) return;
          resolve(md);
        });
      });
      await session.writeInput(COMPACT_PROMPT, { internal: true });
      const timed = new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
      });
      return await Promise.race([got, timed]);
    } finally {
      if (unsubscribe) (unsubscribe as () => void)();
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }

  // === inbox ===

  subscribeInbox(cb: InboxSubscriber): () => void {
    this.inboxSubscribers.add(cb);
    return () => this.inboxSubscribers.delete(cb);
  }

  /**
   * Broadcast a workspace-layer event (project lifecycle, convergence
   * round status, etc.) to inbox subscribers. The event is treated as
   * opaque pass-through; kbbl does not interpret or persist it. Same
   * delivery contract as session-scoped deltas: best-effort to current
   * subscribers, no replay on reconnect.
   */
  broadcastWorkspaceEvent(event: WorkspaceEvent): void {
    this.broadcastDelta({ type: "workspace_event", event });
  }

  private broadcastDelta(delta: InboxDelta): void {
    for (const cb of this.inboxSubscribers) {
      try {
        cb(delta);
      } catch (err) {
        // One bad subscriber shouldn't block the others or corrupt
        // in-session state — mirror the Session.emit subscriber contract.
        console.error(
          `kbbl: inbox subscriber failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private scheduleActivityDelta(sid: string, ts: string): void {
    const now = Date.now();
    const lastFlush = this.lastActivityFlushAt.get(sid) ?? 0;
    const elapsed = now - lastFlush;
    if (elapsed >= LAST_ACTIVITY_THROTTLE_MS) {
      this.lastActivityFlushAt.set(sid, now);
      this.broadcastDelta({ type: "last_activity_changed", sid, ts });
      return;
    }
    // Inside the throttle window. If a trailing timer is already scheduled
    // it'll pick up the newest ts from the session's snapshot when it
    // fires — no need to reschedule, just drop this tick.
    if (this.pendingActivityTimers.has(sid)) return;
    const delay = LAST_ACTIVITY_THROTTLE_MS - elapsed;
    const timer = setTimeout(() => {
      this.pendingActivityTimers.delete(sid);
      this.flushActivity(sid);
    }, delay);
    this.pendingActivityTimers.set(sid, timer);
  }

  private flushActivity(sid: string): void {
    const session = this.sessions.get(sid);
    if (!session) return;
    this.lastActivityFlushAt.set(sid, Date.now());
    this.broadcastDelta({
      type: "last_activity_changed",
      sid,
      ts: session.snapshot().lastActivityTs,
    });
  }

  private clearActivityTimer(sid: string): void {
    const timer = this.pendingActivityTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      this.pendingActivityTimers.delete(sid);
      // Flush the latest activity ts on teardown so a session that ends
      // inside the throttle window doesn't strand its final
      // subprocess_exited/last-emit ts in a cancelled trailing timer.
      this.flushActivity(sid);
    }
    this.lastActivityFlushAt.delete(sid);
  }
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

/**
 * Extract concatenated markdown from a CC `result` event's content
 * blocks. Returns the joined text of all `type: "text"` blocks, or null
 * if the payload doesn't have a content array (e.g. the result was a
 * tool call rather than an end_turn). Caller's one-shot subscriber
 * re-resolves on a different result event in that case.
 */
function extractCompactMarkdown(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const stopReason = (payload as { stop_reason?: unknown }).stop_reason;
  if (stopReason !== "end_turn") return null;
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * Reads the highest event `id` written to the JSONL at the given path.
 * Returns -1 if the file is empty, missing, or contains no parseable events.
 * Used by relaunch() to seed Session.nextId past the pre-restart history so
 * recovery events never collide with already-written ids.
 */
async function readMaxEventId(jsonlPath: string): Promise<number> {
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch {
    return -1;
  }
  let max = -1;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "number" && parsed.id > max) max = parsed.id;
    } catch {
      // skip malformed lines
    }
  }
  return max;
}

/**
 * Reconstructs a SessionSnapshot from an on-disk JSONL. Used by archived
 * scans and (via the caller) /:sid/events fall-through for sessions that
 * aren't in memory — e.g. after a server restart. Returns null if the file
 * is empty, missing, or unreadable, since an empty jsonl can't yield a
 * useful row and a single unreadable jsonl shouldn't fail the whole
 * archived-list response.
 */

// Named payload shapes for the observed-model reconstruction branches.
// Each lists only the field(s) the corresponding case reads; values come
// in as `unknown` from JSON.parse so the runtime checks below stay
// authoritative — the types document intent and keep narrowing local to
// each case instead of repeating ad-hoc `(payload as {...})` casts.
type ModelObservedPayload = { model?: unknown };
type SystemInitPayload = { subtype?: unknown; model?: unknown };
type AssistantPayload = { message?: unknown };

async function loadArchivedSnapshot(
  sid: string,
  jsonlPath: string,
  registry?: RuntimeRegistry,
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
  let ccSid: string | null = null;
  let parentCcSid: string | null = null;
  let parentOakridgeSid: string | null = null;
  let artifactId: ArtifactId | null = null;
  let lastActivityTs = "";
  const allowedTools = new Set<string>();
  let yoloMode = false;
  let lastResultUsage: ResultUsage | null = null;
  // Phase 1+ worktree metadata. All four absent = pre-Phase-1 session;
  // present = isolated worktree may still be on disk (or may have been
  // discarded via Phase 2 — caller must handle ENOENT on worktreePath).
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  let worktreeBaseRef: string | null = null;
  let projectWorkdir: string | null = null;
  let model: string | null = null;
  // Authoritative source: `model_observed` envelope events (first-wins for
  // initialObservedModel, last-wins for observedModel).
  // Back-compat fallback: scan system+init payload.model (first-wins) and
  // assistant payload.message.model (last-wins) so sessions written before
  // `model_observed` existed still reconstruct from data sitting in the
  // same JSONL. No isAllowedModel gate — observedModel is runtime truth
  // and may legitimately be a date-suffixed snapshot id or future version.
  let observedModel: string | null = null;
  let initialObservedModel: string | null = null;
  let endReason: SessionEndReason | null = null;
  let successorSid: string | null = null;
  const events: EnvelopeEvent[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    if (registry) events.push(evt);
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
          // The Session constructor enforces the same invariants on
          // the live path; this is the read-side fallback.
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
        // No allowlist gate: model is stored as-is from session_started.
        // The allowlist gate lives at the HTTP route (POST /sessions)
        // and the adapter's spawn-time validation; archived snapshots
        // must faithfully replay whatever was stored, including future
        // model ids and date-suffixed snapshot strings that weren't in
        // the allowlist at write time.
        if (typeof sessionStartedPayload.model === "string") {
          model = sessionStartedPayload.model;
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
        // First-wins to match the live policy (system+init seeds observedModel
        // before any assistant message arrives).
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
        // (e.g. a subagent) updates observedModel just as the live path does.
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
        // earlier compact_completed. A compacted session always exits its
        // subprocess afterwards, and we want endReason to remain "compacted"
        // for that case rather than getting clobbered by the trailing exit.
        // Note: user_closed sessions (endAll / operator close) are also
        // archived as "subprocess_exited" because no user_closed event is
        // written to the JSONL — endReason reconstruction is best-effort.
        if (endReason === null) endReason = "subprocess_exited";
        break;
      }
    }
  }
  // When a registry is available, delegate runtime-specific field reconstruction
  // to the adapter. Its reconstructSnapshot() is authoritative for runtimeSid
  // (including cc_session_id_observed on old JSONL) and other runtime fields.
  if (registry) {
    const runtime = registry.runtimes.get(runtimeId);
    if (runtime) {
      const contrib = runtime.reconstructSnapshot(events);
      if (contrib.runtimeSid !== null) ccSid = contrib.runtimeSid;
      yoloMode = contrib.yoloMode;
      allowedTools.clear();
      for (const t of contrib.allowedTools) allowedTools.add(t);
      if (contrib.lastResultUsage) lastResultUsage = contrib.lastResultUsage;
      if (contrib.initialObservedModel !== null) {
        initialObservedModel = contrib.initialObservedModel;
      }
      if (contrib.observedModel !== null) observedModel = contrib.observedModel;
    }
  }
  if (!createdAt) return null;
  return {
    sid,
    name: name || `session-${sid.slice(0, 8)}`,
    workdir,
    // If the file is on disk and not in memory, by definition the session
    // is no longer running. A more sophisticated check would look for a
    // subprocess_exited event, but its absence just means the process
    // didn't get a chance to write it (e.g. server crash) — the session
    // is still ended either way.
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
    initialObservedModel,
    observedModel,
    endReason,
    successorSid,
  };
}
