/**
 * AgentRuntime — the contract between kbbl core and runtime adapters.
 *
 * v0 sketch. Nothing in core imports this yet; the Claude Code-specific code
 * is still inline. The interface is here so the architecture is legible and
 * a second adapter spec can be drafted against it. Will be sharpened when
 * the core/adapter split (PR 2 + PR 3 of the restructure) lands and again
 * when the codex adapter exposes assumptions baked into the CC adapter.
 *
 * See comms/oakridge-restructure-spec.md for the design rationale.
 */

import type { Hono } from "hono";

// === core types ===

export type SessionHandle = {
  /** opaque kbbl-side session id (not the runtime's own id, if any) */
  sessionId: string;
};

/** opaque pointer to a stored prior session, used by resume() */
export type ArchiveRef = string;

export type ApprovalDecision = "approve" | "deny" | "always_allow" | "always_deny";

export type RuntimeConfig = {
  workingDirectory: string;
  initialPrompt?: string;
  /** adapter-specific config (model, flags, env, etc.) */
  runtimeSpecific?: Record<string, unknown>;
};

export type RuntimeState = {
  status: "running" | "waiting_for_approval" | "completed" | "errored";
  pendingApprovals: Array<{ requestId: string; reason: string }>;
};

/**
 * The event union that runtime adapters emit and core consumes.
 *
 * `envelope` is the v0 escape hatch: adapters that produce richer event
 * vocabularies (Claude Code's NDJSON, codex's stream, etc.) forward those
 * payloads opaquely on this variant. Core writes them to JSONL and the PWA
 * renders them with adapter-aware components. A future iteration may grow
 * structured variants (assistant turn, tool call with linkage, thinking)
 * so the PWA can render generically without knowing the adapter, but that
 * decision is deferred until a second adapter clarifies the requirements.
 */
export type RuntimeEvent =
  | { type: "envelope"; payload: unknown }
  | { type: "output"; content: string }
  | { type: "tool_request"; tool: string; input: unknown; requestId: string }
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

// === the contract ===

export interface AgentRuntime {
  /** Stable identifier for the runtime (e.g., "claude-code", "codex"). */
  readonly id: string;

  // --- lifecycle ---

  spawn(config: RuntimeConfig): Promise<SessionHandle>;

  /**
   * Fork an archived session as a new live session.
   * Adapters that don't support this throw UnsupportedOperation("resume").
   */
  resume(archiveRef: ArchiveRef, config: RuntimeConfig): Promise<SessionHandle>;

  terminate(session: SessionHandle): Promise<void>;

  // --- streams ---

  /** Runtime emits events; core consumes (writes JSONL, broadcasts SSE). */
  events(session: SessionHandle): AsyncIterable<RuntimeEvent>;

  // --- approval protocol ---

  /**
   * Core mediates approvals (operator taps PWA -> core calls respond()).
   * Adapters route this back to their underlying mechanism (CC's hook
   * stdout, codex's input channel, etc.).
   */
  respond(
    session: SessionHandle,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;

  // --- input forwarding ---

  /** Operator sends text/commands back into the session. */
  send(session: SessionHandle, input: string): Promise<void>;

  // --- introspection ---

  state(session: SessionHandle): Promise<RuntimeState>;

  // --- HTTP route registration ---

  /**
   * Adapters that need their own HTTP routes (e.g., the CC adapter's
   * /hook/approval endpoint that gate.sh posts to) mount them here.
   * Called once at server startup, after core has built its app.
   */
  mountRoutes?(app: Hono): void;
}

// === registry ===

/**
 * Minimal v0 registry: a map keyed by runtime id. Core hardcodes the import
 * of the CC adapter at server startup and registers it here. A plugin loader
 * is YAGNI until a second adapter ships.
 */
export type RuntimeRegistry = Map<string, AgentRuntime>;
