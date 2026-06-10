import type { Context } from "hono";
import { randomUUID } from "node:crypto";

import type { Decision, Session } from "../../core/session/session";
import type { SessionManager } from "../../core/session/session-manager";
import { notifyApprovalNeeded } from "../../core/server/callbacks";

/**
 * CC native http hook payloads.
 *
 * CC POSTs these directly to kbbl's hook routes. Fields marked optional are
 * event-type-specific; session_id and hook_event_name are always present.
 */
export interface HookInput {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  [key: string]: unknown;
}

export interface HookHandlerDeps {
  manager: SessionManager;
  /**
   * Returns the Bun server instance for `requestIP` loopback verification.
   * Must be a getter (not the value) because bunServer is assigned after
   * Bun.serve() runs, which is after route registration.
   */
  getBunServer: () => import("bun").Server<unknown> | null;
  /**
   * Per-session SubagentStop count for billing observability (A.7).
   * Key is oakridgeSid; value is cumulative count for this server lifetime.
   */
  subagentCounts: Map<string, number>;
}

/**
 * POST /hook/permission — PermissionRequest approval gate.
 *
 * Filters to 127.0.0.1, looks up the session by CC session_id, applies
 * yolo/allowlist auto-approve, otherwise parks the decision until the
 * operator taps Approve/Deny in the PWA.
 *
 * Returns { hookSpecificOutput: { hookEventName: "PermissionRequest",
 * permissionDecision: "allow" | "deny" | "ask", permissionDecisionReason } }
 * as CC requires — NOT decision.behavior (that's the SDK canUseTool programmatic
 * return, not the hook JSON; a wrong shape is silently ignored and CC keeps
 * blocking the tool).
 */
export function hookPermissionHandler(deps: HookHandlerDeps) {
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
    if (hook.hook_event_name !== "PermissionRequest") {
      return c.json(
        { error: `unexpected hook_event_name: ${hook.hook_event_name}` },
        400,
      );
    }
    // A well-formed PermissionRequest always carries the tool being gated and the
    // tool_use it targets. Downstream consumers key off both — allowlisting uses
    // tool_name, approvals are keyed to tool_use_id — so a missing value would let
    // an "Always" allowlist the empty string or register an approval against no
    // tool. Reject malformed payloads with an explicit deny (never stall CC).
    if (
      typeof hook.tool_name !== "string" ||
      hook.tool_name.length === 0 ||
      typeof hook.tool_use_id !== "string" ||
      hook.tool_use_id.length === 0
    ) {
      console.error(
        `kbbl: /hook/permission — malformed PermissionRequest (tool_name=${
          hook.tool_name ?? "<missing>"
        }, tool_use_id=${hook.tool_use_id ?? "<missing>"}), denying`,
      );
      return c.json(
        {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            permissionDecision: "deny",
            permissionDecisionReason:
              "malformed PermissionRequest: missing tool_name or tool_use_id",
          },
        },
        200,
      );
    }

    const session = await resolveSessionForHook(deps.manager, hook.session_id);
    if (!session) {
      console.error(
        `kbbl: /hook/permission — no session for ccSid ${hook.session_id}, denying`,
      );
      return c.json(
        {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            permissionDecision: "deny",
            permissionDecisionReason: "no kbbl session for this CC session id",
          },
        },
        200,
      );
    }

    const autoReason = session.yolo
      ? "yolo"
      : session.toolAllowlist.has(hook.tool_name ?? "")
        ? "allowlist"
        : null;
    if (autoReason) {
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
      // PermissionRequest hook response shape: CC (verified against 2.1.169 in
      // phase0/RESULTS.md) expects hookSpecificOutput.permissionDecision
      // ("allow"|"deny"|"ask") + permissionDecisionReason — NOT decision.behavior
      // (that's the SDK canUseTool programmatic return, not the hook JSON). A
      // wrong shape is silently ignored and CC keeps blocking the tool.
      return c.json({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          permissionDecision: "allow",
          permissionDecisionReason: `auto-approved (${autoReason})`,
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
      toolName: hook.tool_name ?? "",
    });
    const delegatedCb = deps.manager.getDelegatedCallback(session.oakridgeSid);
    if (delegatedCb) {
      notifyApprovalNeeded(delegatedCb, requestId, hook.tool_name ?? "", session.oakridgeSid);
    }
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
          hookEventName: "PermissionRequest",
          permissionDecision: decision,
          permissionDecisionReason:
            decision === "allow" ? "operator approved" : "operator denied",
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
      } else {
        console.error(
          `kbbl: /hook/permission failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Return an explicit deny so CC receives a decision rather than a hook
      // failure (which may stall the agent). Diagnostics are in logs/events.
      return c.json({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          permissionDecision: "deny",
          permissionDecisionReason: isGateAbort ? "gate aborted" : "hook handler error",
        },
      });
    }
  };
}

/** POST /hook/tool — PostToolUse informational event. */
export function hookPostToolUseHandler(deps: HookHandlerDeps) {
  return makeInformationalHandler(deps, "PostToolUse", "hook_post_tool_use");
}

/** POST /hook/stop — Stop informational event (turn complete). */
export function hookStopHandler(deps: HookHandlerDeps) {
  return makeInformationalHandler(deps, "Stop", "hook_stop");
}

/** POST /hook/session-start — SessionStart informational event. */
export function hookSessionStartHandler(deps: HookHandlerDeps) {
  return makeInformationalHandler(deps, "SessionStart", "hook_session_start");
}

/** POST /hook/session-end — SessionEnd informational event. */
export function hookSessionEndHandler(deps: HookHandlerDeps) {
  return makeInformationalHandler(deps, "SessionEnd", "hook_session_end");
}

/**
 * POST /hook/notification — Notification event.
 *
 * Used by the frontend to decide whether to open the break-glass xterm.js
 * view. The notification_type field distinguishes permission_prompt (waiting
 * on approval the PermissionRequest hook should have caught) from idle_prompt
 * (waiting on next turn).
 */
export function hookNotificationHandler(deps: HookHandlerDeps) {
  return makeInformationalHandler(deps, "Notification", "hook_notification");
}

/** POST /hook/subagent-start — SubagentStart informational event. */
export function hookSubagentStartHandler(deps: HookHandlerDeps) {
  return makeInformationalHandler(deps, "SubagentStart", "hook_subagent_start");
}

/**
 * POST /hook/subagent-stop — SubagentStop with billing observability (A.7).
 *
 * Counts SubagentStop events per session. The count is emitted in the event
 * payload so it can be correlated with the Agent SDK meter delta for billing
 * validation.
 */
export function hookSubagentStopHandler(deps: HookHandlerDeps) {
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
      return c.json({}, 200);
    }
    if (hook.hook_event_name !== "SubagentStop") {
      return c.json({}, 200);
    }

    const session = await resolveSessionForHook(deps.manager, hook.session_id);
    if (session) {
      const prev = deps.subagentCounts.get(session.oakridgeSid) ?? 0;
      const count = prev + 1;
      deps.subagentCounts.set(session.oakridgeSid, count);
      console.log(
        `kbbl: subagent_stopped sid=${session.oakridgeSid} count=${count}`,
      );
      session
        .emit("subagent_stopped", { ...hook, subagent_count: count })
        .catch((err) => {
          console.error(
            `kbbl: subagent_stopped emit failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
    return c.json({}, 200);
  };
}

/**
 * Factory for fire-and-forget informational hook handlers. Emits a structured
 * event into the session and returns 200 immediately — CC does not wait on a
 * specific response shape for non-decision hooks.
 *
 * Uses resolveSessionForHook to tolerate the hooks/stdout race at session
 * startup: events that arrive before system/init maps the ccSid would
 * otherwise be silently dropped.
 *
 * @param expectedHookEvent - CC hook_event_name expected on this route (e.g.
 *   "PostToolUse"). Mismatches are silently dropped so a miswired URL or CC
 *   routing change cannot misclassify events in the transcript.
 */
function makeInformationalHandler(
  deps: HookHandlerDeps,
  expectedHookEvent: string,
  eventType: string,
) {
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
      return c.json({}, 200);
    }
    if (hook.hook_event_name !== expectedHookEvent) {
      return c.json({}, 200);
    }

    // resolveSessionForHook absorbs the hooks/stdout race: informational hooks
    // can fire before system/init has established the ccSid→oakridgeSid mapping.
    resolveSessionForHook(deps.manager, hook.session_id).then((session) => {
      if (session) {
        session.emit(eventType, { ...hook }).catch((err) => {
          console.error(
            `kbbl: ${eventType} emit failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }).catch(() => {});
    return c.json({}, 200);
  };
}

/**
 * Map a hook's CC session_id to our Session. Waits briefly if the
 * manager hasn't seen the ccSid yet: CC emits system/init before any
 * PermissionRequest under normal conditions, but hooks and stdout are separate
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
