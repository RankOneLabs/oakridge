import type { Context } from "hono";
import { randomUUID } from "node:crypto";

import type { Decision, Session } from "../../core/session/session";
import type { SessionManager } from "../../core/session/session-manager";

/**
 * CC PreToolUse hook payload.
 *
 * NOTE: This module is Claude Code-specific. CC's hook protocol (the JSON
 * shape on stdin to the gate, the hookSpecificOutput shape on stdout) is a
 * CC concept. In PR 3 this file moves into kbbl/adapters/claude-code/ and
 * registers itself via AgentRuntime.mountRoutes() in the runtime interface.
 */
export interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  hook_event_name: string;
}

export interface HookHandlerDeps {
  manager: SessionManager;
  /**
   * Returns the Bun server instance for `requestIP` loopback verification.
   * Must be a getter (not the value) because bunServer is assigned after
   * Bun.serve() runs, which is after route registration.
   */
  getBunServer: () => import("bun").Server<unknown> | null;
}

/**
 * POST /hook/approval — the parking endpoint that CC's PreToolUse gate
 * script calls into. Filters to 127.0.0.1, looks up the session by CC
 * session_id, applies yolo/allowlist auto-approve, otherwise parks the
 * decision until the operator taps Approve/Deny in the PWA.
 */
export function hookApprovalHandler(deps: HookHandlerDeps) {
  return async (c: Context) => {
    const bunServer = deps.getBunServer();
    if (!bunServer) return c.text("server not ready", 503);
    const info = bunServer.requestIP(c.req.raw);
    if (!info || (info.address !== "127.0.0.1" && info.address !== "::1")) {
      return c.text("forbidden", 403);
    }

    let hook: HookInput;
    try {
      hook = (await c.req.json()) as HookInput;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (hook.hook_event_name !== "PreToolUse") {
      return c.json(
        { error: `unexpected hook_event_name: ${hook.hook_event_name}` },
        400,
      );
    }

    const session = await resolveSessionForHook(deps.manager, hook.session_id);
    if (!session) {
      // The gate reached us before system/init mapped this ccSid to a session.
      // Deny rather than hang so CC isn't wedged waiting on us.
      return c.json(
        {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "kbbl: no oakridge session for this CC session_id",
          },
        },
        200,
      );
    }

    const autoReason = session.yolo
      ? "yolo"
      : session.toolAllowlist.has(hook.tool_name)
        ? "allowlist"
        : null;
    if (autoReason) {
      // Log the auto-approve best-effort. If emit throws (disk full, perm
      // error), still return the allow decision — the auto-approve policy
      // doesn't depend on the log being durable, and wedging CC on a log
      // failure would be worse than a missing event line.
      try {
        await session.emit("permission_auto_approved", {
          tool_name: hook.tool_name,
          tool_input: hook.tool_input,
          tool_use_id: hook.tool_use_id,
          reason: autoReason,
        });
      } catch (err) {
        console.error(
          `kbbl: failed to log auto-approve for ${hook.tool_name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return c.json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason:
            autoReason === "yolo"
              ? "auto-approved (yolo mode)"
              : `auto-approved (always allow ${hook.tool_name})`,
        },
      });
    }

    const requestId = randomUUID();
    const signal = c.req.raw.signal;
    let resolveDecision: (d: Decision) => void;
    let rejectDecision: (e: Error) => void;
    const decisionPromise = new Promise<Decision>((res, rej) => {
      resolveDecision = res;
      rejectDecision = rej;
    });
    session.registerApproval(requestId, {
      resolve: resolveDecision!,
      toolName: hook.tool_name,
    });
    signal.addEventListener(
      "abort",
      () => rejectDecision!(new Error("gate_aborted")),
      { once: true },
    );

    try {
      await session.emit("permission_request", {
        request_id: requestId,
        tool_name: hook.tool_name,
        tool_input: hook.tool_input,
        tool_use_id: hook.tool_use_id,
      });
      const decision = await decisionPromise;
      await session.emit("permission_resolved", {
        request_id: requestId,
        decision,
      });
      return c.json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason:
            decision === "allow"
              ? "operator approved via kbbl"
              : "operator denied via kbbl",
        },
      });
    } catch (err) {
      const isGateAbort =
        err instanceof Error && err.message === "gate_aborted";
      session.deleteApproval(requestId);
      if (isGateAbort) {
        await session
          .emit("permission_resolved", {
            request_id: requestId,
            decision: "deny",
            reason: "gate_aborted",
          })
          .catch((e) => {
            console.error(
              `kbbl: failed to emit gate-aborted resolution: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
        return c.json({ error: "gate aborted" }, 408);
      }
      console.error(
        `kbbl: /hook/approval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: "internal error" }, 500);
    }
  };
}

/**
 * Map a hook's CC session_id to our Session. Waits briefly if the
 * manager hasn't seen the ccSid yet: CC emits system/init before any
 * PreToolUse under normal conditions, but hooks and stdout are separate
 * pipes and in theory could race. 2s should cover any realistic scheduling
 * jitter while still failing fast on a genuinely-unknown ccSid.
 */
async function resolveSessionForHook(
  manager: SessionManager,
  ccSid: string,
): Promise<Session | undefined> {
  const deadline = Date.now() + 2000;
  while (true) {
    const session = manager.getByCcSid(ccSid);
    if (session) return session;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
}
