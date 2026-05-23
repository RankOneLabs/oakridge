import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnvelopeEvent, Session, SessionStatus } from "../../core/session/session";
import { hookApprovalHandler } from "./hook-route";
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

describe("hookApprovalHandler: yolo auto-approves", () => {
  test("yolo session auto-approves any tool", async () => {
    const { session, emitted } = makeFakeSession({ yolo: true });
    const manager = makeFakeManager(session, CC_SID);
    const handler = hookApprovalHandler({
      manager,
      getBunServer: () => ({
        requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
      }) as unknown as import("bun").Server<unknown>,
    });

    const ctx = { req: { json: () => Promise.resolve({
      hook_event_name: "PreToolUse",
      session_id: CC_SID,
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "tu-3",
    }), raw: { signal: new AbortController().signal } }, json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }) };
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };

    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("yolo");

    const event = emitted.find((e) => e.type === "permission_auto_approved");
    expect((event!.payload as { reason: string }).reason).toBe("yolo");
  });
});

describe("hookApprovalHandler: allowlist auto-approves", () => {
  test("allowlisted tool auto-approves", async () => {
    const { session, emitted } = makeFakeSession({ toolAllowlist: ["Read"] });
    const manager = makeFakeManager(session, CC_SID);
    const handler = hookApprovalHandler({
      manager,
      getBunServer: () => ({
        requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
      }) as unknown as import("bun").Server<unknown>,
    });

    const ctx = { req: { json: () => Promise.resolve({
      hook_event_name: "PreToolUse",
      session_id: CC_SID,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo" },
      tool_use_id: "tu-1",
    }), raw: { signal: new AbortController().signal } }, json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }) };
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string } };

    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");

    const event = emitted.find((e) => e.type === "permission_auto_approved");
    expect((event!.payload as { reason: string }).reason).toBe("allowlist");
  });
});
