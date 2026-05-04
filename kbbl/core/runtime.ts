import type { Hono } from "hono";

import type { Session, SpawnCmd } from "./session/session";
import type { SessionManager } from "./session/session-manager";

/**
 * The minimal runtime contract core consumes today.
 *
 * This is the v0 working interface: just enough surface area to let the
 * Claude Code adapter own its spawn command and HTTP routes without core
 * importing CC-specific files. The richer aspirational interface (spawn,
 * resume, terminate, events, respond — see ./runtime-interface.ts) is the
 * direction this evolves once a second adapter (codex) clarifies what
 * actually needs to be in the contract.
 *
 * Adapter responsibilities under this contract:
 * - Construct the per-session `SpawnCmd` consumed by SessionManager
 * - Mount any adapter-specific HTTP routes (e.g., the CC PreToolUse gate)
 *
 * What still leaks across the boundary in v0 (deferred follow-up):
 * - Session.stdout pump knows about CC's `system + subtype:init` event for
 *   ccSid capture. Should become a runtime-provided classifier callback.
 * - SessionManager owns `ccSidToOakridgeSid`. Should be adapter-owned.
 * - `resolveResumeParent` parses CC-specific event types out of JSONL.
 *   Should become `runtime.resolveResumeRef()`.
 */
export interface AppRuntime {
  /** Stable identifier for the runtime (e.g., "claude-code", "codex"). */
  readonly id: string;

  /**
   * Adapter-specific spawn command construction. Called by SessionManager
   * for each new session. The adapter captures any static state (settings
   * path, env vars, CLI flags) at adapter-creation time and uses the
   * Session here only for per-instance values (workdir, parentCcSid).
   */
  buildSpawnCmd(session: Session): SpawnCmd;

  /**
   * Mount adapter HTTP routes on the Hono app. Called once at server
   * startup, before Bun.serve. Adapters that need their own loopback
   * endpoints (CC's gate posts to /hook/approval) register them here.
   */
  mountRoutes(
    app: Hono,
    deps: {
      manager: SessionManager;
      getBunServer: () => import("bun").Server<unknown> | null;
    },
  ): void;

  /**
   * Optional: inspect each parsed runtime stdout event after core has
   * already emitted it to JSONL/subscribers. Called by the Session stdout
   * pump. The adapter may:
   *   - Update Session metadata via `session.observeRuntimeSessionId()` /
   *     `session.setLastResultUsage()` (e.g., capture CC's session_id from
   *     the system/init event for hook routing).
   *   - Emit additional events via `session.emit()`.
   *
   * Errors from the classifier are caught and logged; classifier failure
   * never kills the pump or affects the original event delivery.
   *
   * Adapters with no per-event work (or that classify exclusively via the
   * raw events the PWA already receives) can omit this method.
   */
  classifyEvent?(rawEvent: unknown, session: Session): Promise<void>;
}
