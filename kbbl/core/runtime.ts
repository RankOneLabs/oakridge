import type { Hono } from "hono";

import type { Session, EnvelopeEvent, SpawnCmd } from "./session/session";
import type { SessionManager } from "./session/session-manager";
import type { ResultUsage } from "./session/types";

// === runtime identity ===

export type RuntimeId = "claude-code" | "codex";

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  models: readonly { value: string; label: string }[];
  supportsCompaction: boolean;
}

// === session handle ===

export type SessionHandle = {
  /** opaque kbbl-side session id */
  readonly sessionId: string;
  /** runtime-internal id, when the adapter learns it during spawn */
  readonly runtimeSid?: string | null;
  /** model the runtime resolved during spawn, when available */
  readonly resolvedModel?: string | null;
};

export type ArchiveRef = string;

export type ApprovalDecision = "allow" | "deny" | "always_allow" | "always_deny";

export interface RuntimeConfig {
  workingDirectory: string;
  initialPrompt?: string;
  /** adapter-specific config (model, flags, env, etc.) */
  runtimeSpecific?: Record<string, unknown>;
}

/**
 * The event union that runtime adapters emit and core consumes.
 *
 * `envelope` is the escape hatch: adapters that produce richer event
 * vocabularies (Claude Code's NDJSON, codex's stream, etc.) forward those
 * payloads opaquely on this variant. Core writes them to JSONL and the PWA
 * renders them with adapter-aware components.
 */
export type RuntimeEvent =
  | { type: "envelope"; payload: unknown }
  | { type: "output"; content: string }
  | { type: "approval_required"; reason: string; requestId: string }
  | { type: "completed"; result: unknown }
  | { type: "error"; message: string };

/**
 * Thrown by adapters when the operator requests an operation the runtime
 * cannot support (e.g., resume on a runtime that doesn't preserve state).
 * Core should render this as a user-visible message in the inbox UI.
 */
export class UnsupportedOperation extends Error {
  constructor(
    public readonly operation: string,
    message?: string,
  ) {
    super(message ?? `runtime does not support: ${operation}`);
    this.name = "UnsupportedOperation";
  }
}

// === resume result ===

export type ResumeRef =
  | {
      kind: "ok";
      runtimeSid: string;
      workdir: string;
      parentWorktreePath: string | null;
      model: string | null;
    }
  | { kind: "unknown" | "no_runtime_sid" | "no_workdir" };

// === snapshot contribution ===

export interface RuntimeSnapshotContrib {
  runtimeSid: string | null;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: ResultUsage | null;
  initialObservedModel: string | null;
  observedModel: string | null;
}

// === the contract ===

export interface AgentRuntime {
  /** Stable identifier for the runtime (e.g., "claude-code", "codex"). */
  readonly id: RuntimeId;
  readonly descriptor: RuntimeDescriptor;

  // --- lifecycle ---

  spawn(config: RuntimeConfig): Promise<SessionHandle>;
  terminate(handle: SessionHandle): Promise<void>;

  // --- streams ---

  /**
   * Runtime emits events; core consumes (writes JSONL, broadcasts SSE).
   *
   * Cancellation contract: callers stop reading by breaking the for-await loop,
   * which triggers the iterator's `return()` method. Adapters that wrap
   * long-lived resources (subprocess stdio pipes, network sockets, timers)
   * MUST implement `return()` on the returned iterator to release them.
   */
  events(handle: SessionHandle): AsyncIterable<RuntimeEvent>;

  // --- input ---

  /** Operator sends text/commands back into the session. */
  send(handle: SessionHandle, input: string): Promise<void>;

  /**
   * True when the runtime does not echo operator input back as a `user`
   * envelope event by ANY path. Core synthesizes one for those runtimes after
   * accepting external input. Codex sets this — its protocol never echoes input
   * back. Claude Code does NOT: it writes each channel-pushed message into its
   * transcript as a channel-origin `user` row when it ingests it, and the CC
   * adapter's transcript transform surfaces that as the `user` event — so
   * synthesizing as well would both double the message and insert it before CC
   * has actually processed it. (Earlier this looked true for CC because it
   * doesn't echo through its stdout event stream; the transcript bridge is the
   * path that was overlooked.)
   */
  synthesizeUserInputEvents?: boolean;
  /**
   * True when the runtime has no turn-state machine (no Stop hook driving
   * notifyTurnEnd), so operator input must be sent immediately rather than
   * deferred through the per-turn input queue — queuing would deadlock because
   * nothing ever flushes it. Codex sets this; Claude Code does not (its Stop
   * hook drives the turn queue, so its input is delivered at turn boundaries).
   */
  sendsWithoutTurnQueue?: boolean;

  /**
   * Optional: cancel the in-flight turn immediately. Unlike send(), this MUST
   * bypass every turn-queue / quiescence gate — its entire purpose is to land
   * mid-turn, the moment the operator sees the model going wrong and wants it to
   * stop, WITHOUT killing the session (that is terminate()). The CC adapter
   * writes a raw ESC byte to the PTY — the same key an interactive operator
   * presses. The channel transport cannot do this: a channel push is only
   * ingested when CC starts a new turn, so it can never cancel the turn already
   * running. Runtimes with no interrupt affordance omit this; core treats its
   * absence as "interrupt unsupported".
   */
  interrupt?(handle: SessionHandle): Promise<void>;

  // --- approval ---

  respond?(
    handle: SessionHandle,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;

  // --- per-event classification ---

  /**
   * Optional: inspect each parsed runtime event after core has already emitted
   * it to JSONL/subscribers. The adapter may call session.observeRuntimeSessionId(),
   * session.observeTurnEnd(), etc. Errors are caught + logged; classifier failure
   * never kills the pump. Adapters with no per-event work can omit this.
   */
  classifyEvent?(rawEvent: unknown, session: Session): Promise<void>;

  /**
   * Optional: event types that should NOT be persisted to the on-disk JSONL
   * transcript but still fan out to live subscribers. CC's `stream_event`
   * records are the motivating case — high volume, the canonical transcript
   * record is the final `assistant` event.
   */
  nonPersistedEventTypes?: ReadonlySet<string>;

  // --- HTTP routes ---

  /**
   * Adapters that need their own HTTP routes (e.g., the CC adapter's
   * /hook/approval endpoint) mount them here. Called once at server startup.
   */
  mountRoutes?(
    app: Hono,
    deps: {
      manager: SessionManager;
      getBunServer: () => import("bun").Server<unknown> | null;
    },
  ): void;

  // --- resume ---

  /**
   * Resolve the information needed to resume a prior session. Reads the
   * JSONL for the given oakridgeSid and extracts runtime-specific fields.
   * Returns a tagged result so the POST /sessions handler can map each
   * failure case to a distinct status code.
   */
  resolveResumeRef(
    sessionsDir: string,
    oakridgeSid: string,
  ): Promise<ResumeRef>;

  /**
   * Reconstruct adapter-specific snapshot fields from an archived event
   * sequence. Called by loadArchivedSnapshot() so CC-specific JSONL parsing
   * stays in the CC adapter rather than leaking into core.
   */
  reconstructSnapshot(events: readonly EnvelopeEvent[]): RuntimeSnapshotContrib;

  /**
   * Optional: validate a model string for this runtime. When present, used
   * by POST /sessions to gate the `model` field. If absent, core falls back
   * to a static LEGACY_ALLOWED_MODELS list. Implement this to accept short
   * aliases (e.g. "sonnet") in addition to fully-pinned model ids.
   */
  isAllowedModel?(model: string): boolean;
}

// === registry ===

export type RuntimeRegistry = {
  runtimes: Map<RuntimeId, AgentRuntime>;
  defaultId: RuntimeId;
};

export function createRuntimeRegistry(
  runtimes: AgentRuntime[],
  configuredDefaultId?: RuntimeId,
): RuntimeRegistry {
  if (runtimes.length === 0) {
    throw new Error("createRuntimeRegistry: runtimes array must not be empty");
  }
  const map = new Map<RuntimeId, AgentRuntime>();
  for (const r of runtimes) {
    if (map.has(r.id)) {
      throw new Error(`createRuntimeRegistry: duplicate runtime id "${r.id}"`);
    }
    map.set(r.id, r);
  }
  const defaultId: RuntimeId =
    configuredDefaultId ??
    (map.has("claude-code") ? "claude-code" : runtimes[0].id);
  if (!map.has(defaultId)) {
    const registered = [...map.keys()].join(", ");
    throw new Error(
      `createRuntimeRegistry: configured default runtime "${defaultId}" is not registered — registered: ${registered}`,
    );
  }
  return { runtimes: map, defaultId };
}

// === backward-compat alias ===

/**
 * @deprecated Use AgentRuntime. AppRuntime is kept for the v0 → v1
 * transition; all new code should import AgentRuntime from this module.
 *
 * Legacy adapter surface: just buildSpawnCmd + mountRoutes + optional
 * classifyEvent/nonPersistedEventTypes. Existing code wired through
 * SessionManagerOpts.buildSpawnCmd continues to work unchanged.
 */
export interface AppRuntime {
  readonly id: string;
  buildSpawnCmd(session: Session): Promise<SpawnCmd>;
  mountRoutes(
    app: Hono,
    deps: {
      manager: SessionManager;
      getBunServer: () => import("bun").Server<unknown> | null;
    },
  ): void;
  classifyEvent?(rawEvent: unknown, session: Session): Promise<void>;
  nonPersistedEventTypes?: ReadonlySet<string>;
}
