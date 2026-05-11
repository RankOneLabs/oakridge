import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionProfile } from "../../core/safir/types";
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

function makeProfile(
  overrides: Partial<PermissionProfile> & Pick<PermissionProfile, "rules">,
): PermissionProfile {
  return {
    id: 1,
    name: "test-profile",
    description: null,
    is_seed: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeFakeSession(opts: {
  profile: PermissionProfile | null;
  yolo?: boolean;
  toolAllowlist?: string[];
  ccSid?: string;
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
    permissionProfile: opts.profile,
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

function makeHookRequest(tool_name: string, tool_input: unknown, session_id: string) {
  return new Request("http://localhost/hook/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id,
      tool_name,
      tool_input,
      tool_use_id: "tu-1",
    }),
  });
}

const CC_SID = "mock-cc-sid-1";

describe("hookApprovalHandler: profile auto-approve", () => {
  test("auto-approves tools matched by read-only-investigation profile", async () => {
    const profile = makeProfile({
      name: "read-only-investigation",
      rules: {
        auto_approve: [{ tool: "Read" }, { tool: "Grep" }],
        always_prompt: [],
        deny: [],
      },
    });
    const { session, emitted } = makeFakeSession({ profile });
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
    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };

    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("profile:read-only-investigation");

    const autoApproveEvent = emitted.find((e) => e.type === "permission_auto_approved");
    expect(autoApproveEvent).toBeDefined();
    expect((autoApproveEvent!.payload as { reason: string }).reason).toBe("profile:read-only-investigation");
  });

  test("auto-denies tools matched by deny list", async () => {
    const profile = makeProfile({
      name: "read-only-investigation",
      rules: {
        auto_approve: [],
        always_prompt: [],
        deny: ["Write", "Edit"],
      },
    });
    const { session, emitted } = makeFakeSession({ profile });
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
      tool_use_id: "tu-2",
    }), raw: { signal: new AbortController().signal } }, json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }) };
    const res = await handler(ctx as Parameters<typeof handler>[0]);
    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string } };

    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");

    const deniedEvent = emitted.find((e) => e.type === "permission_auto_denied");
    expect(deniedEvent).toBeDefined();
    expect((deniedEvent!.payload as { reason: string }).reason).toContain("profile:read-only-investigation");
  });
});

describe("hookApprovalHandler: yolo bypasses profile evaluation", () => {
  test("yolo session auto-approves regardless of deny list", async () => {
    const profile = makeProfile({
      rules: { auto_approve: [], always_prompt: [], deny: ["Write"] },
    });
    const { session, emitted } = makeFakeSession({ profile, yolo: true });
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
