import type { Context } from "hono";
import { randomUUID } from "node:crypto";

import type { Decision, Session } from "../../core/session/session";
import type { SessionManager } from "../../core/session/session-manager";
import { ensureTranscriptTailer } from "./transcript-tailer";

/**
 * CC native http hook payloads.
 *
 * CC POSTs these directly to kbbl's hook routes. The payload is a discriminated
 * union over `hook_event_name`: each of the eight events kbbl subscribes to has
 * its own variant carrying only the fields CC sends for that event. `session_id`
 * is common to all. Narrow at the HTTP boundary with `parseHookInput` before
 * routing, so an impossible shape never reaches a handler.
 */
export type HookEventName =
  | "PermissionRequest"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop";

/** Fields CC stamps on every hook payload regardless of event. */
interface HookCommon {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
}

export interface PermissionRequestHook extends HookCommon {
  hook_event_name: "PermissionRequest";
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
}

export interface PostToolUseHook extends HookCommon {
  hook_event_name: "PostToolUse";
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
}

export interface StopHook extends HookCommon {
  hook_event_name: "Stop";
  stop_hook_active?: boolean;
}

export interface SessionStartHook extends HookCommon {
  hook_event_name: "SessionStart";
  source?: string;
}

export interface SessionEndHook extends HookCommon {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export interface NotificationHook extends HookCommon {
  hook_event_name: "Notification";
  message?: string;
  notification_type?: string;
}

export interface SubagentStartHook extends HookCommon {
  hook_event_name: "SubagentStart";
}

export interface SubagentStopHook extends HookCommon {
  hook_event_name: "SubagentStop";
  stop_hook_active?: boolean;
}

export type HookInput =
  | PermissionRequestHook
  | PostToolUseHook
  | StopHook
  | SessionStartHook
  | SessionEndHook
  | NotificationHook
  | SubagentStartHook
  | SubagentStopHook;

const HOOK_EVENT_NAMES: ReadonlySet<string> = new Set<HookEventName>([
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "SubagentStart",
  "SubagentStop",
]);

/** Project-local Result — see kbbl/core/pwa/lib/result.ts for the same shape. */
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Trace context for a rejected hook body at the HTTP boundary. Carries the
 * operation, the offending session id when one was present, and a human-readable
 * detail so a dropped hook can be traced back to why the parser refused it
 * (distinguishing a missing session_id from an unknown event from a malformed
 * field — outcomes a bare `null` would have collapsed into one).
 */
export interface HookParseError {
  operation: "parse_hook_input";
  entity_id?: string;
  detail: string;
}

function hookParseErr(
  detail: string,
  entity_id?: string,
): Result<HookInput, HookParseError> {
  return { ok: false, error: { operation: "parse_hook_input", entity_id, detail } };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/**
 * Narrow a parsed JSON body into the HookInput union at the HTTP boundary.
 * Returns an `Err` carrying trace context for anything that isn't an object
 * with a string `session_id`, a recognized `hook_event_name`, and well-typed
 * optional fields — `tool_name`/`tool_use_id`/`transcript_path`/`cwd` must be
 * strings when present and `stop_hook_active` a boolean, so a non-string tool
 * name can't masquerade as typed hook data downstream. Returns `Ok(hook)` once
 * the discriminant and every field downstream code treats as typed validate.
 */
export function parseHookInput(raw: unknown): Result<HookInput, HookParseError> {
  if (typeof raw !== "object" || raw === null) {
    return hookParseErr("body is not a JSON object");
  }
  const obj = raw as {
    session_id?: unknown;
    hook_event_name?: unknown;
    tool_name?: unknown;
    tool_use_id?: unknown;
    transcript_path?: unknown;
    cwd?: unknown;
    stop_hook_active?: unknown;
    message?: unknown;
    notification_type?: unknown;
    reason?: unknown;
    source?: unknown;
  };
  if (typeof obj.session_id !== "string") {
    return hookParseErr("missing or non-string session_id");
  }
  if (
    typeof obj.hook_event_name !== "string" ||
    !HOOK_EVENT_NAMES.has(obj.hook_event_name)
  ) {
    return hookParseErr(
      `unrecognized hook_event_name: ${String(obj.hook_event_name)}`,
      obj.session_id,
    );
  }
  if (!isOptionalString(obj.transcript_path) || !isOptionalString(obj.cwd)) {
    return hookParseErr(
      "transcript_path/cwd must be strings when present",
      obj.session_id,
    );
  }
  if (!isOptionalString(obj.tool_name) || !isOptionalString(obj.tool_use_id)) {
    return hookParseErr(
      "tool_name/tool_use_id must be strings when present",
      obj.session_id,
    );
  }
  if (
    !isOptionalString(obj.message) ||
    !isOptionalString(obj.notification_type) ||
    !isOptionalString(obj.reason) ||
    !isOptionalString(obj.source)
  ) {
    return hookParseErr(
      "message/notification_type/reason/source must be strings when present",
      obj.session_id,
    );
  }
  if (!isOptionalBoolean(obj.stop_hook_active)) {
    return hookParseErr(
      "stop_hook_active must be a boolean when present",
      obj.session_id,
    );
  }
  return { ok: true, value: obj as unknown as HookInput };
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
 * decision: { behavior: "allow" | "deny" } } } as CC requires.
 */
export function hookPermissionHandler(deps: HookHandlerDeps) {
  return async (c: Context) => {
    const bunServer = deps.getBunServer();
    if (!bunServer) return c.text("server not ready", 503);
    const info = bunServer.requestIP(c.req.raw);
    if (!info || (info.address !== "127.0.0.1" && info.address !== "::1")) {
      return c.text("forbidden", 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = parseHookInput(raw);
    if (!parsed.ok || parsed.value.hook_event_name !== "PermissionRequest") {
      const detail = parsed.ok
        ? `unexpected hook_event_name: ${parsed.value.hook_event_name}`
        : parsed.error.detail;
      console.error(`kbbl: /hook/permission rejected body: ${detail}`);
      return c.json({ error: detail }, 400);
    }
    const hook = parsed.value;

    const session = await resolveSessionForHook(deps.manager, hook.session_id);
    if (!session) {
      console.error(
        `kbbl: /hook/permission — no session for ccSid ${hook.session_id}, denying`,
      );
      return c.json(
        {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny" },
          },
        },
        200,
      );
    }

    // Backstop in case SessionStart was missed: the permission hook also
    // carries the transcript path. ensureTranscriptTailer is idempotent.
    if (hook.transcript_path) {
      ensureTranscriptTailer(session, hook.transcript_path);
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
      return c.json({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
          },
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
          decision: {
            behavior: decision,
          },
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
          decision: { behavior: "deny" },
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

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({}, 200);
    }
    const parsed = parseHookInput(raw);
    if (!parsed.ok || parsed.value.hook_event_name !== "SubagentStop") {
      return c.json({}, 200);
    }
    const hook = parsed.value;

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
  expectedHookEvent: HookEventName,
  eventType: string,
) {
  return async (c: Context) => {
    const bunServer = deps.getBunServer();
    if (!bunServer) return c.text("server not ready", 503);
    const info = bunServer.requestIP(c.req.raw);
    if (!info || (info.address !== "127.0.0.1" && info.address !== "::1")) {
      return c.text("forbidden", 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({}, 200);
    }
    const parsed = parseHookInput(raw);
    if (!parsed.ok || parsed.value.hook_event_name !== expectedHookEvent) {
      return c.json({}, 200);
    }
    const hook = parsed.value;

    // resolveSessionForHook absorbs the hooks/stdout race: informational hooks
    // can fire before system/init has established the ccSid→oakridgeSid mapping.
    resolveSessionForHook(deps.manager, hook.session_id).then((session) => {
      if (session) {
        // In PTY mode the only source of user/assistant/result events is CC's
        // on-disk transcript. Every hook carries its path; start the tailer
        // here (idempotent) so SessionStart — the first hook — brings the
        // Conversation view online.
        if (hook.transcript_path) {
          ensureTranscriptTailer(session, hook.transcript_path);
        }
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
