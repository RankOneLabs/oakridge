import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnvelopeEvent, Session, SessionStatus } from "../../core/session/session";
import { hookPermissionHandler, hookSubagentStopHandler, hookPostToolUseHandler, parseHookInput } from "./hook-route";
import type { SessionManager } from "../../core/session/session-manager";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-hookroute-test-"));
  mkdirSync(join(tmpRoot, "sessions"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFakeSession(opts: {
  yolo?: boolean;
  toolAllowlist?: string[];
  status?: SessionStatus;
}): {
  session: Session;
  emitted: EnvelopeEvent[];
} {
  const emitted: EnvelopeEvent[] = [];
  let nextId = 0;
  const session = {
    oakridgeSid: "fake-session-id",
    status: opts.status ?? "live",
    yolo: opts.yolo ?? false,
    toolAllowlist: new Set(opts.toolAllowlist ?? []),
    pendingApprovals: new Map(),
    emit: async (type: string, payload: unknown) => {
      const evt: EnvelopeEvent = { id: nextId++, type, ts: new Date().toISOString(), payload };
      emitted.push(evt);
      return evt;
    },
    registerApproval: () => {},
    deleteApproval: () => {},
  } as unknown as Session;
  return { session, emitted };
}

function makeFakeManager(session: Session | null, ccSid: string): SessionManager {
  return {
    getByCcSid: (id: string) => (id === ccSid ? session ?? undefined : undefined),
  } as unknown as SessionManager;
}

const CC_SID = "mock-cc-sid-1";

function makeHookDeps(session: Session | null, ccSid = CC_SID) {
  return {
    manager: makeFakeManager(session, ccSid),
    getBunServer: () => ({
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    }) as unknown as import("bun").Server<unknown>,
    subagentCounts: new Map<string, number>(),
  };
}

function makeCtx(body: unknown) {
  return {
    req: {
      json: () => Promise.resolve(body),
      raw: { signal: new AbortController().signal },
    },
    json: (b: unknown, status?: number) => new Response(JSON.stringify(b), { status: status ?? 200 }),
    text: (b: string, status?: number) => new Response(b, { status: status ?? 200 }),
  };
}

describe("parseHookInput: traced Result at the HTTP boundary", () => {
  test("Ok for a well-formed PermissionRequest body", () => {
    const result = parseHookInput({
      hook_event_name: "PermissionRequest",
      session_id: CC_SID,
      tool_name: "Write",
      tool_use_id: "tu-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hook_event_name).toBe("PermissionRequest");
      expect(result.value.session_id).toBe(CC_SID);
    }
  });

  test("Err with trace context for a non-object body", () => {
    const result = parseHookInput("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.operation).toBe("parse_hook_input");
      expect(result.error.detail).toContain("not a JSON object");
    }
  });

  test("Err for a missing session_id, distinct from an unknown event", () => {
    const noSid = parseHookInput({ hook_event_name: "Stop" });
    const badEvent = parseHookInput({ hook_event_name: "Nope", session_id: CC_SID });
    expect(noSid.ok).toBe(false);
    expect(badEvent.ok).toBe(false);
    if (!noSid.ok) expect(noSid.error.detail).toContain("session_id");
    if (!badEvent.ok) {
      expect(badEvent.error.detail).toContain("hook_event_name");
      // entity_id carries the session id once it is known.
      expect(badEvent.error.entity_id).toBe(CC_SID);
    }
  });

  test("Err when a typed optional field has the wrong type", () => {
    const result = parseHookInput({
      hook_event_name: "PostToolUse",
      session_id: CC_SID,
      tool_name: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toContain("tool_name");
      expect(result.error.entity_id).toBe(CC_SID);
    }
  });
});

describe("hookPermissionHandler: yolo auto-approves", () => {
  test("yolo session auto-approves any tool", async () => {
    const { session, emitted } = makeFakeSession({ yolo: true });
    const handler = hookPermissionHandler(makeHookDeps(session));

    const ctx = makeCtx({
      hook_event_name: "PermissionRequest",
      session_id: CC_SID,
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "tu-3",
    });
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    const body = await res.json() as {
      hookSpecificOutput: { hookEventName: string; decision: { behavior: string } };
    };

    expect(body.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(body.hookSpecificOutput.decision.behavior).toBe("allow");

    const event = emitted.find((e) => e.type === "permission_auto_approved");
    expect(event).toMatchObject({ payload: { reason: "yolo" } });
  });
});

describe("hookPermissionHandler: allowlist auto-approves", () => {
  test("allowlisted tool auto-approves", async () => {
    const { session, emitted } = makeFakeSession({ toolAllowlist: ["Read"] });
    const handler = hookPermissionHandler(makeHookDeps(session));

    const ctx = makeCtx({
      hook_event_name: "PermissionRequest",
      session_id: CC_SID,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo" },
      tool_use_id: "tu-1",
    });
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    const body = await res.json() as {
      hookSpecificOutput: { hookEventName: string; decision: { behavior: string } };
    };

    expect(body.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(body.hookSpecificOutput.decision.behavior).toBe("allow");

    const event = emitted.find((e) => e.type === "permission_auto_approved");
    expect(event).toMatchObject({ payload: { reason: "allowlist" } });
  });
});

describe("hookPermissionHandler: session not found", () => {
  test("returns minimal deny (no extra fields) when session cannot be resolved", async () => {
    const handler = hookPermissionHandler(makeHookDeps(null));

    const ctx = makeCtx({
      hook_event_name: "PermissionRequest",
      session_id: "unknown-sid",
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "tu-99",
    });
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    const body = await res.json() as {
      hookSpecificOutput: { hookEventName: string; decision: Record<string, unknown> };
    };

    expect(body.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(body.hookSpecificOutput.decision.behavior).toBe("deny");
    // CC may reject strict-mode hook output with extra fields; keep decision minimal.
    expect(Object.keys(body.hookSpecificOutput.decision)).toEqual(["behavior"]);
  });
});

describe("hookSubagentStopHandler: billing observability", () => {
  test("ignores payloads with wrong hook_event_name", async () => {
    const { session } = makeFakeSession({});
    const deps = makeHookDeps(session);
    const handler = hookSubagentStopHandler(deps);

    const ctx = makeCtx({ hook_event_name: "PostToolUse", session_id: CC_SID });
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    expect(res.status).toBe(200);
    expect(deps.subagentCounts.get("fake-session-id")).toBeUndefined();
  });

  test("increments subagentCounts and emits subagent_stopped with count", async () => {
    const { session, emitted } = makeFakeSession({});
    const deps = makeHookDeps(session);
    const handler = hookSubagentStopHandler(deps);

    const ctx1 = makeCtx({
      hook_event_name: "SubagentStop",
      session_id: CC_SID,
    });
    await handler(ctx1 as Parameters<typeof handler>[0]);

    const ctx2 = makeCtx({
      hook_event_name: "SubagentStop",
      session_id: CC_SID,
    });
    await handler(ctx2 as Parameters<typeof handler>[0]);

    expect(deps.subagentCounts.get("fake-session-id")).toBe(2);

    // Give fire-and-forget emits a tick to settle
    await new Promise((r) => setTimeout(r, 10));
    const stopEvents = emitted.filter((e) => e.type === "subagent_stopped");
    expect(stopEvents.length).toBe(2);
    expect((stopEvents[0].payload as { subagent_count: number }).subagent_count).toBe(1);
    expect((stopEvents[1].payload as { subagent_count: number }).subagent_count).toBe(2);
  });
});

describe("hookPostToolUseHandler: informational", () => {
  test("emits hook_post_tool_use event and returns 200", async () => {
    const { session, emitted } = makeFakeSession({});
    const handler = hookPostToolUseHandler(makeHookDeps(session));

    const ctx = makeCtx({
      hook_event_name: "PostToolUse",
      session_id: CC_SID,
      tool_name: "Read",
      tool_use_id: "tu-42",
    });
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    expect(emitted.some((e) => e.type === "hook_post_tool_use")).toBe(true);
  });

  test("drops event silently when hook_event_name does not match route", async () => {
    const { session, emitted } = makeFakeSession({});
    const handler = hookPostToolUseHandler(makeHookDeps(session));

    const ctx = makeCtx({
      hook_event_name: "Stop", // wrong event for /hook/tool
      session_id: CC_SID,
    });
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    expect(emitted.some((e) => e.type === "hook_post_tool_use")).toBe(false);
  });
});
