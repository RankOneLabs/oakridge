import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { KbblConfig } from "../config";
import type { SafirClient } from "../safir/client";
import type { SafirQueue } from "../safir/queue";
import { safirCall } from "../safir/safir-call";
import {
  MAX_ARTIFACT_ID_LENGTH,
  Session,
  extractResultUsage,
  newSessionId,
  readJsonlOrEmpty,
  type EnvelopeEvent,
  type ResultUsage,
  type SessionEndReason,
  type SessionSnapshot,
  type SessionStatus,
  type SpawnCmd,
} from "./session";
import {
  WorktreeCreateError,
  createWorktree,
  isGitRepo,
  removeWorktree,
} from "./worktree";
import { isAllowedModel } from "../../adapters/claude-code/models";

export interface SessionManagerOpts {
  sessionsDir: string;
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
   */
  buildSpawnCmd: (session: Session) => SpawnCmd;
  /**
   * Optional runtime-adapter classifier wired into each Session's stdout
   * pump. The adapter inspects raw events and updates Session metadata
   * (observeRuntimeSessionId, observeTurnEnd). Adapters with no
   * per-event work omit this.
   */
  classifyEvent?: (rawEvent: unknown, session: Session) => Promise<void>;
  /**
   * Optional set of event types Session.emit() will broadcast but skip
   * writing to the JSONL transcript. See AppRuntime.nonPersistedEventTypes
   * for rationale.
   */
  nonPersistedEventTypes?: ReadonlySet<string>;
  /**
   * Validated kbbl config (compact thresholds, retention window, safir
   * endpoint). Loaded once at server startup and threaded through here so
   * Phase 1+ consumers (compactor, retention sweep, safir client) can
   * read from a single source of truth. Phase 0 stores it without
   * consuming it; subsequent phases pull what they need.
   */
  config: KbblConfig;
  /**
   * safir HTTP client + persistent retry queue for kbbl→safir lifecycle
   * writes. Wired in PR-A; first consumed in PR-B (createSession opens a
   * run/phase, markEnded closes the phase). Always provided by the server
   * boot path; tests pass stubs or lightweight real implementations
   * depending on what the test exercises.
   */
  safirClient: SafirClient;
  safirQueue: SafirQueue;
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
  artifactId?: string;
  /**
   * Runtime model id; passed through to Session and into the spawn argv
   * by the adapter's buildSpawnCmd. null/omitted → no --model flag,
   * CC picks its default. Validation (allowlist, length) happens at the
   * HTTP route, not here.
   */
  model?: string | null;
  taskId?: number;
  runId?: string;
  parentPhaseId?: string;
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
export interface WorkspaceEvent {
  /** Event kind, e.g. "project_created", "convergence_round_started". */
  kind: string;
  /** Opaque project id from legit-biz-club. */
  projectId: string;
  /** Wall-clock ISO timestamp; emitter-supplied or defaulted on receipt. */
  ts: string;
  /** Event-specific payload. Treated as opaque by kbbl. */
  payload: Record<string, unknown>;
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
  | { type: "status_changed"; sid: string; status: SessionStatus }
  | { type: "pending_count_changed"; sid: string; count: number }
  | { type: "last_activity_changed"; sid: string; ts: string }
  | { type: "yolo_changed"; sid: string; yoloMode: boolean }
  | { type: "workspace_event"; event: WorkspaceEvent };

export interface InboxSnapshot {
  sessions: SessionSnapshot[];
}

type InboxSubscriber = (delta: InboxDelta) => void;

const LAST_ACTIVITY_THROTTLE_MS = 1000;

/**
 * Parse the depth encoded in a kbbl worktree branch. `kbbl/<sid8>-r<n>`
 * → n; bare `kbbl/<sid8>` → 0. Anything else (an operator-renamed branch,
 * a non-kbbl branch we shouldn't have been handed) → 0 with a logged
 * warning, since assuming any other value would silently produce a wrong
 * depth on the next resume.
 */
function parseDepthFromBranch(branch: string): number {
  const m = /^kbbl\/[0-9a-f]{8}(?:-r(\d+))?$/.exec(branch);
  if (!m) {
    console.error(
      `kbbl: parent branch ${branch} doesn't match kbbl/<sid8>[-r<n>] — depth defaulting to 0`,
    );
    return 0;
  }
  return m[1] ? Number.parseInt(m[1], 10) : 0;
}

export class SessionManager {
  private readonly opts: SessionManagerOpts;
  private readonly sessions = new Map<string, Session>();
  /**
   * Maps CC's session_id (captured from system/init) back to our
   * oakridgeSid, so /hook/approval can route incoming hooks — which carry
   * CC's session_id in the payload, not ours — to the right Session.
   */
  private readonly ccSidToOakridgeSid = new Map<string, string>();

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

  async create(opts: CreateSessionOpts): Promise<Session> {
    const oakridgeSid = newSessionId();
    // Server-side fallback so requests without a usable name still produce a
    // human-readable session name. `name` is optional in practice, and
    // resume/default client flows may omit it, so this can run for normal
    // client traffic as well as direct API hits.
    const name =
      opts.name && opts.name.trim() ? opts.name.trim() : `session-${oakridgeSid.slice(0, 8)}`;

    // Per-session worktree (Phase 1). On = each session gets its own
    // checkout + branch off the operator workdir's HEAD; spawn cwd becomes
    // the worktree path. Off (or non-repo workdir) = pre-Phase-1 behavior,
    // spawn into the operator workdir directly. The flag exists for
    // rollout safety; Phase 3 flips the default. See
    // comms/kbbl-session-worktrees-handoff.md.
    let worktreePath: string | null = null;
    let worktreeBranch: string | null = null;
    let worktreeBaseRef: string | null = null;
    // projectWorkdir is non-null only when a worktree is created — in the
    // flag-off / non-repo path, session.workdir IS the operator workdir
    // and there's nothing to dual-label. Keeping it null for those
    // sessions also keeps session_started / SessionSnapshot tight for
    // pre-Phase-1-equivalent payloads.
    let projectWorkdir: string | null = null;
    const wantsWorktree = this.opts.config.sessions.worktree_per_session;
    if (wantsWorktree && (await isGitRepo(opts.workdir))) {
      // On resume, opts.workdir is the parent's workdir — which (Phase 1+)
      // is the parent's worktree path, NOT the operator's original repo.
      // Resolve both depth and the original projectWorkdir from the parent
      // so the new session's metadata points at the original repo (for the
      // PWA dual-label) instead of mistaking the parent's worktree for
      // the project root.
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
      try {
        const created = await createWorktree({
          workdir: opts.workdir,
          worktreesRoot: this.opts.worktreesDir,
          oakridgeSid,
          resumeDepth,
        });
        worktreePath = created.worktreePath;
        worktreeBranch = created.worktreeBranch;
        worktreeBaseRef = created.worktreeBaseRef;
        // Fresh session: opts.workdir IS the operator workdir.
        // Resume of a Phase-1 parent: inherit parent.projectWorkdir.
        // Resume of a pre-Phase-1 parent: meta.projectWorkdir falls back
        // to parent.workdir (which IS the original repo for that case),
        // so this still resolves to the right thing.
        projectWorkdir = inheritedProjectWorkdir ?? opts.workdir;
      } catch (err) {
        if (err instanceof WorktreeCreateError) {
          throw new Error(
            `worktree create failed: ${err.message}\n${err.stderr}`,
          );
        }
        throw err;
      }
    }
    const effectiveWorkdir = worktreePath ?? opts.workdir;

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
      parentCcSid: opts.parentCcSid,
      parentOakridgeSid: opts.parentOakridgeSid,
      artifactId: opts.artifactId,
      worktreePath,
      worktreeBranch,
      worktreeBaseRef,
      projectWorkdir,
      model: opts.model ?? null,
      classifyEvent: this.opts.classifyEvent,
      nonPersistedEventTypes: this.opts.nonPersistedEventTypes,
      callbacks: {
        onCcSidObserved: (s, ccSid) => {
          this.ccSidToOakridgeSid.set(ccSid, s.oakridgeSid);
        },
        onEnded: (s) => {
          const ccSid = s.currentCcSid;
          if (ccSid && this.ccSidToOakridgeSid.get(ccSid) === s.oakridgeSid) {
            this.ccSidToOakridgeSid.delete(ccSid);
          }
          this.clearActivityTimer(s.oakridgeSid);
          this.broadcastDelta({ type: "session_ended", sid: s.oakridgeSid });
          const p = this.afterSessionEnded(s).catch((err) => {
            console.error(
              `kbbl: afterSessionEnded for ${s.oakridgeSid}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
          this.pendingLifecycle.add(p);
          void p.finally(() => this.pendingLifecycle.delete(p));
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
    if (opts.taskId !== undefined || opts.runId !== undefined) {
      await this.openSafirContext(session, opts);
    }
    // Broadcast session_created with the starting-state snapshot before we
    // await spawn(). That way /inbox subscribers see the new row appear
    // immediately and then receive status/pending/activity deltas as the
    // subprocess comes up.
    this.broadcastDelta({ type: "session_created", session: session.snapshot() });
    await session.spawn(this.opts.buildSpawnCmd(session));
    return session;
  }

  private async openSafirContext(
    session: Session,
    opts: CreateSessionOpts,
  ): Promise<void> {
    const ctx = { queue: this.opts.safirQueue };
    const oakridgeSid = session.oakridgeSid;

    if (opts.runId === undefined) {
      const runBody = {
        executor: "claude_code" as const,
        status: "running" as const,
        created_by: "kbbl",
        created_by_session: oakridgeSid,
      };
      const created = await safirCall(
        ctx,
        () => this.opts.safirClient.createRun(opts.taskId!, runBody),
        { method: "POST", path: `/tasks/${opts.taskId}/runs`, body: runBody },
      );
      if (!created) return;

      const phaseBody = {
        oakridge_session_id: oakridgeSid,
        parent_phase_id: opts.parentPhaseId ?? null,
      };
      const phase = await safirCall(
        ctx,
        () => this.opts.safirClient.createPhase(created.id, phaseBody),
        { method: "POST", path: `/runs/${created.id}/phases`, body: phaseBody },
      );
      session.attachSafirContext(created.id, phase ? phase.id : undefined);
      return;
    }

    const phaseBody = {
      oakridge_session_id: oakridgeSid,
      parent_phase_id: opts.parentPhaseId ?? null,
    };
    const phase = await safirCall(
      ctx,
      () => this.opts.safirClient.createPhase(opts.runId!, phaseBody),
      { method: "POST", path: `/runs/${opts.runId}/phases`, body: phaseBody },
    );
    session.attachSafirContext(opts.runId, phase?.id);
  }

  private async afterSessionEnded(s: Session): Promise<void> {
    if (!s.phaseId && !s.runId) return;
    const reason: SessionEndReason = s.endReason ?? "subprocess_exited";
    const isTerminal = reason !== "compacted";
    const ctx = { queue: this.opts.safirQueue };
    const endedAt = new Date().toISOString();

    if (s.phaseId) {
      const phaseBody = {
        ended_at: endedAt,
        end_reason: reason,
        is_terminal: isTerminal,
      };
      await safirCall(
        ctx,
        () => this.opts.safirClient.updatePhase(s.phaseId!, phaseBody),
        { method: "PATCH", path: `/phases/${s.phaseId}`, body: phaseBody },
      );
    }

    if (reason === "user_closed" && s.runId) {
      const runBody = { status: "completed" as const };
      await safirCall(
        ctx,
        () => this.opts.safirClient.updateRun(s.runId!, runBody),
        { method: "PATCH", path: `/runs/${s.runId}`, body: runBody },
      );
    }
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
      const payload = (evt.payload ?? {}) as Record<string, unknown>;
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

  getByCcSid(ccSid: string): Session | undefined {
    const oakridgeSid = this.ccSidToOakridgeSid.get(ccSid);
    return oakridgeSid ? this.sessions.get(oakridgeSid) : undefined;
  }

  /**
   * Find a live session whose `runId` matches. Used by the safir webhook
   * receiver (`handlers/safir-webhook.ts`) to dispatch incoming run events
   * onto the session that owns the run. Returns undefined when no live
   * session matches — the receiver logs and drops in that case rather
   * than buffering. Scans the live map; sessions with status !== "live"
   * (starting, ended) are excluded so a webhook arriving moments after
   * `markEnded` doesn't fan out into a closing session.
   */
  findLiveByRunId(runId: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.status === "live" && s.runId === runId) return s;
    }
    return undefined;
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
  listByArtifact(artifactId: string): Session[] {
    const normalized = artifactId.trim();
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
      const snap = await loadArchivedSnapshot(sid, jsonlPath);
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
 * Reconstructs a SessionSnapshot from an on-disk JSONL. Used by archived
 * scans and (via the caller) /:sid/events fall-through for sessions that
 * aren't in memory — e.g. after a server restart. Returns null if the file
 * is empty, missing, or unreadable, since an empty jsonl can't yield a
 * useful row and a single unreadable jsonl shouldn't fail the whole
 * archived-list response.
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
  let ccSid: string | null = null;
  let parentCcSid: string | null = null;
  let parentOakridgeSid: string | null = null;
  let artifactId: string | null = null;
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
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    lastActivityTs = evt.ts;
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    switch (evt.type) {
      case "session_started": {
        if (createdAt === null) createdAt = evt.ts;
        if (typeof payload.workdir === "string") workdir = payload.workdir;
        if (typeof payload.name === "string") name = payload.name;
        if (typeof payload.parentCcSid === "string") {
          parentCcSid = payload.parentCcSid;
        }
        if (typeof payload.parentOakridgeSid === "string") {
          parentOakridgeSid = payload.parentOakridgeSid;
        }
        if (typeof payload.artifactId === "string") {
          // Mirror POST /sessions validation: trim, ignore empty, and
          // ignore over-cap so malformed/legacy JSONL can't yield
          // artifactId: "" or an unbounded tag in archived snapshots.
          // The Session constructor enforces the same invariants on
          // the live path; this is the read-side fallback.
          const trimmed = payload.artifactId.trim();
          if (trimmed && trimmed.length <= MAX_ARTIFACT_ID_LENGTH) {
            artifactId = trimmed;
          }
        }
        if (typeof payload.worktreePath === "string") {
          worktreePath = payload.worktreePath;
        }
        if (typeof payload.worktreeBranch === "string") {
          worktreeBranch = payload.worktreeBranch;
        }
        if (typeof payload.worktreeBaseRef === "string") {
          worktreeBaseRef = payload.worktreeBaseRef;
        }
        if (typeof payload.projectWorkdir === "string") {
          projectWorkdir = payload.projectWorkdir;
        }
        if (typeof payload.model === "string" && isAllowedModel(payload.model)) {
          model = payload.model;
        }
        break;
      }
      case "cc_session_id_observed": {
        if (typeof payload.cc_session_id === "string") {
          ccSid = payload.cc_session_id;
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
    ccSid,
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
  };
}
