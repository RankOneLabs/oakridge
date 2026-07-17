import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { KbblConfigSchema } from "../config";
import type { Session, WriteInputOpts } from "../session/session";
import { SessionNotReadyError } from "../session/session";
import type { SessionManager } from "../session/session-manager";
import type { RuntimeRegistry, AgentRuntime } from "../runtime";
import type { Skill } from "./types";
import { filterSkillsForSession, buildSkillRegistry } from "./registry";
import { FIXTURE_SKILLS } from "./fixtures";
import { formatMcpSkillRequest, gatedReviewSkills } from "./gated-review";
import { mountSkillsRoutes } from "./routes";

const VALID_SID = "deadbeef-cafe-4abc-8def-aaaaaaaaaaaa";

// Minimal session stub — cast to Session since Session is a large class
function makeSession(overrides: {
  runtimeId?: "claude-code" | "codex";
  status?: "starting" | "live" | "compacting" | "ended";
  writeInput?: (
    text: string,
    opts?: WriteInputOpts,
  ) => Promise<void>;
} = {}): Session {
  return {
    oakridgeSid: VALID_SID,
    runtimeId: overrides.runtimeId ?? "claude-code",
    status: overrides.status ?? "live",
    currentCcSid: null,
    currentObservedModel: null,
    writeInput: overrides.writeInput ?? (() => Promise.resolve()),
  } as unknown as Session;
}

function makeConfig(overrides: { hidden?: string[]; fixtures?: boolean; confirm?: string[] } = {}) {
  return KbblConfigSchema.parse({
    skills: {
      hidden: overrides.hidden ?? [],
      fixtures: overrides.fixtures ?? false,
      confirm: overrides.confirm ?? [],
    },
  });
}

function makeRegistry(discoverFn?: () => Promise<Skill[]>): RuntimeRegistry {
  const runtime: Partial<AgentRuntime> = {
    id: "claude-code",
    discoverSkills: discoverFn,
  };
  return {
    runtimes: new Map([["claude-code", runtime as AgentRuntime]]),
    defaultId: "claude-code",
  };
}

// === filterSkillsForSession ===

describe("filterSkillsForSession", () => {
  const skills: Skill[] = [
    {
      id: "s1",
      name: "list-tasks",
      description: "",
      backend: "claude-code",
      scope: "user",
      args: [],
      user_invocable: true,
      model_invocable: true,
    },
    {
      id: "s2",
      name: "deploy",
      description: "",
      backend: "claude-code",
      scope: "user",
      args: [],
      user_invocable: true,
      model_invocable: false,
    },
  ];

  test("returns all skills when hidden list is empty", () => {
    const result = filterSkillsForSession(makeSession(), skills, []);
    expect(result).toEqual(skills);
  });

  test("drops skills whose name is in the hidden list", () => {
    const result = filterSkillsForSession(makeSession(), skills, ["deploy"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  test("hidden list is matched by name, not id", () => {
    const result = filterSkillsForSession(makeSession(), skills, ["s1"]);
    expect(result).toHaveLength(2); // "s1" is the id, not the name
  });
});

// === buildSkillRegistry.aggregate ===

describe("buildSkillRegistry aggregate()", () => {
  test("returns [] when registry is undefined and fixtures is false", async () => {
    const config = makeConfig();
    const agg = buildSkillRegistry({ registry: undefined, config });
    const result = await agg.aggregate(makeSession());
    expect(result).toEqual([]);
  });

  test("returns [] when runtime has no discoverSkills", async () => {
    const registry: RuntimeRegistry = {
      runtimes: new Map([
        [
          "claude-code",
          { id: "claude-code" } as unknown as AgentRuntime,
        ],
      ]),
      defaultId: "claude-code",
    };
    const config = makeConfig();
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result).toEqual([]);
  });

  test("returns [] when discoverSkills throws", async () => {
    const registry = makeRegistry(() => {
      throw new Error("discovery exploded");
    });
    const config = makeConfig();
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result).toEqual([]);
  });

  test("drops user_invocable=false skills", async () => {
    const skills: Skill[] = [
      {
        id: "visible",
        name: "visible-skill",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: false,
      },
      {
        id: "hidden-internal",
        name: "internal",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: false,
        model_invocable: true,
      },
    ];
    const registry = makeRegistry(() => Promise.resolve(skills));
    const config = makeConfig();
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("visible");
  });

  test("applies the hidden name denylist after user_invocable filter", async () => {
    const skills: Skill[] = [
      {
        id: "s1",
        name: "deploy",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: false,
      },
      {
        id: "s2",
        name: "list-tasks",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: true,
      },
    ];
    const registry = makeRegistry(() => Promise.resolve(skills));
    const config = makeConfig({ hidden: ["deploy"] });
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("list-tasks");
  });

  test("fixtures mode returns only skills matching session.runtimeId", async () => {
    const config = makeConfig({ fixtures: true });
    const agg = buildSkillRegistry({ registry: undefined, config });

    const ccResult = await agg.aggregate(makeSession({ runtimeId: "claude-code" }));
    expect(ccResult.every((s) => s.backend === "claude-code")).toBe(true);

    const codexResult = await agg.aggregate(makeSession({ runtimeId: "codex" }));
    expect(codexResult.every((s) => s.backend === "codex")).toBe(true);
  });

  test("fixtures mode returns FIXTURE_SKILLS minus user_invocable=false", async () => {
    const config = makeConfig({ fixtures: true });
    const agg = buildSkillRegistry({ registry: undefined, config });
    const result = await agg.aggregate(makeSession({ runtimeId: "claude-code" }));

    // Only CC fixtures, minus the one with user_invocable=false
    const expectedCount = FIXTURE_SKILLS.filter(
      (s) => s.backend === "claude-code" && s.user_invocable !== false,
    ).length;
    expect(result).toHaveLength(expectedCount);
    expect(result.every((s) => s.user_invocable !== false)).toBe(true);
  });

  test("fixtures mode still applies the hidden denylist", async () => {
    const config = makeConfig({ fixtures: true, hidden: ["list-tasks"] });
    const agg = buildSkillRegistry({ registry: undefined, config });
    const result = await agg.aggregate(makeSession());
    expect(result.every((s) => s.name !== "list-tasks")).toBe(true);
  });

  test("confirm annotation: empty allowlist means no skill gets confirm=true", async () => {
    const skills: Skill[] = [
      {
        id: "s1",
        name: "deploy",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: false,
      },
    ];
    const registry = makeRegistry(() => Promise.resolve(skills));
    const config = makeConfig(); // confirm defaults to []
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result.every((s) => s.confirm !== true)).toBe(true);
  });

  test("confirm annotation: skills matching the allowlist get confirm=true, others get confirm=false", async () => {
    const skills: Skill[] = [
      {
        id: "s1",
        name: "deploy",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: false,
      },
      {
        id: "s2",
        name: "list-tasks",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: true,
      },
    ];
    const registry = makeRegistry(() => Promise.resolve(skills));
    const config = makeConfig({ confirm: ["deploy"] });
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result.find((s) => s.name === "deploy")?.confirm).toBe(true);
    expect(result.find((s) => s.name === "list-tasks")?.confirm).toBe(false);
  });

  test("confirm annotation: mutating gated-review skills are gated by default", async () => {
    const skills: Skill[] = [
      {
        id: "cc:mcp:gated-review:git.push",
        name: "mcp:gated-review:git.push",
        description: "",
        backend: "claude-code",
        scope: "system",
        args: [],
        user_invocable: true,
        model_invocable: true,
      },
      {
        id: "cc:mcp:gated-review:get_review_round",
        name: "mcp:gated-review:get_review_round",
        description: "",
        backend: "claude-code",
        scope: "system",
        args: [],
        user_invocable: true,
        model_invocable: true,
      },
    ];
    const registry = makeRegistry(() => Promise.resolve(skills));
    const config = KbblConfigSchema.parse({});
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result.find((s) => s.name === "mcp:gated-review:git.push")?.confirm).toBe(
      true,
    );
    expect(
      result.find((s) => s.name === "mcp:gated-review:get_review_round")?.confirm,
    ).toBe(false);
  });

  test("confirm annotation runs after hidden filter: hidden skills are absent from result", async () => {
    const skills: Skill[] = [
      {
        id: "s1",
        name: "deploy",
        description: "",
        backend: "claude-code",
        scope: "user",
        args: [],
        user_invocable: true,
        model_invocable: false,
      },
    ];
    const registry = makeRegistry(() => Promise.resolve(skills));
    // deploy is in both the confirm allowlist and the hidden denylist
    const config = makeConfig({ confirm: ["deploy"], hidden: ["deploy"] });
    const agg = buildSkillRegistry({ registry, config });
    const result = await agg.aggregate(makeSession());
    expect(result).toHaveLength(0);
  });
});

// === routes ===

function buildRoutesApp(opts: {
  session?: Session | null;
  registry?: RuntimeRegistry;
  hidden?: string[];
  fixtures?: boolean;
}): Hono {
  const { session, registry } = opts;
  const manager: Partial<SessionManager> = {
    get: (sid: string) =>
      sid === VALID_SID && session !== undefined
        ? (session ?? undefined)
        : undefined,
  };
  const config = makeConfig({ hidden: opts.hidden, fixtures: opts.fixtures });
  const app = new Hono();
  mountSkillsRoutes(app, {
    manager: manager as SessionManager,
    registry,
    config,
  });
  return app;
}

describe("GET /:sid/skills", () => {
  test("returns 400 for invalid sid", async () => {
    const app = buildRoutesApp({ session: null });
    const res = await app.fetch(new Request("http://kbbl.test/not-a-uuid/skills"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/invalid sid/);
  });

  test("returns 200 [] for unknown session (not in manager)", async () => {
    const app = buildRoutesApp({ session: null });
    const res = await app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/skills`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns 200 [] for a non-live (ended) session", async () => {
    const session = makeSession({ status: "ended" });
    const app = buildRoutesApp({ session, fixtures: true });
    const res = await app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/skills`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns 200 with fixture skills in fixtures mode", async () => {
    const session = makeSession();
    const app = buildRoutesApp({ session, fixtures: true });
    const res = await app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/skills`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Skill[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((s) => s.user_invocable !== false)).toBe(true);
  });

  test("returns 200 [] when runtime has no discoverSkills (not fixtures mode)", async () => {
    const session = makeSession();
    const registry: RuntimeRegistry = {
      runtimes: new Map([
        ["claude-code", { id: "claude-code" } as unknown as AgentRuntime],
      ]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry });
    const res = await app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/skills`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /:sid/skills/invoke", () => {
  const SKILL_ID = "cc-list-tasks"; // present in FIXTURE_SKILLS, user_invocable=true

  function post(app: Hono, body: unknown) {
    return app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/skills/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("returns 400 for invalid sid", async () => {
    const app = buildRoutesApp({ session: null });
    const res = await app.fetch(
      new Request("http://kbbl.test/not-a-uuid/skills/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill_id: SKILL_ID }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown session", async () => {
    const app = buildRoutesApp({ session: null });
    const res = await post(app, { skill_id: SKILL_ID });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toMatch(/unknown session/);
  });

  test("returns 400 when an args value is not a string", async () => {
    const session = makeSession();
    const app = buildRoutesApp({ session, fixtures: true });
    const res = await post(app, { skill_id: SKILL_ID, args: { query: 123 } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/args\.query must be a string/);
  });

  test("returns 404 for unknown or hidden skill id", async () => {
    const session = makeSession();
    const app = buildRoutesApp({ session, fixtures: true });
    const res = await post(app, { skill_id: "does-not-exist" });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toMatch(/unknown or hidden skill/);
  });

  test("returns 400 for missing required arg", async () => {
    const session = makeSession({ runtimeId: "codex" });
    const app = buildRoutesApp({ session, fixtures: true });
    // codex-search has a required arg "query"
    const res = await post(app, { skill_id: "codex-search", args: {} });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/missing required arg/);
  });

  test("returns 409 when runtime lacks formatSkillInvocation", async () => {
    const session = makeSession();
    const registry: RuntimeRegistry = {
      runtimes: new Map([
        [
          "claude-code",
          {
            id: "claude-code",
            discoverSkills: async () => [
              {
                id: SKILL_ID,
                name: "list-tasks",
                description: "",
                backend: "claude-code",
                scope: "user",
                args: [],
                user_invocable: true,
                model_invocable: true,
              },
            ],
            // no formatSkillInvocation
          } as unknown as AgentRuntime,
        ],
      ]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry, fixtures: false });
    const res = await post(app, { skill_id: SKILL_ID });
    expect(res.status).toBe(409);
  });

  test("returns 503 when writeInput throws SessionNotReadyError", async () => {
    const session = makeSession({
      writeInput: async () => {
        throw new SessionNotReadyError();
      },
    });
    const registry: RuntimeRegistry = {
      runtimes: new Map([
        [
          "claude-code",
          {
            id: "claude-code",
            discoverSkills: async () => [
              {
                id: SKILL_ID,
                name: "list-tasks",
                description: "",
                backend: "claude-code",
                scope: "user",
                args: [],
                user_invocable: true,
                model_invocable: true,
              },
            ],
            formatSkillInvocation: () => "/list-tasks",
          } as unknown as AgentRuntime,
        ],
      ]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry, fixtures: false });
    const res = await post(app, { skill_id: SKILL_ID });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/subprocess not ready/);
  });

  test("returns 200 { ok: true } and writes trigger on success (fixtures mode)", async () => {
    let captured: string | null = null;
    let capturedCommand = false;
    const session = makeSession({
      writeInput: async (text, opts) => {
        captured = text;
        capturedCommand = opts?.command === true;
      },
    });
    const registry: RuntimeRegistry = {
      runtimes: new Map([
        [
          "claude-code",
          {
            id: "claude-code",
            formatSkillInvocation: (_skill: Skill, _args: Record<string, string>) =>
              "/list-tasks",
          } as unknown as AgentRuntime,
        ],
      ]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry, fixtures: true });
    const res = await post(app, { skill_id: SKILL_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(captured as unknown as string).toBe("/list-tasks");
    expect(capturedCommand).toBe(true);
  });

  test("ack-only — no result envelope in the 200 body", async () => {
    const session = makeSession();
    const registry: RuntimeRegistry = {
      runtimes: new Map([
        [
          "claude-code",
          {
            id: "claude-code",
            formatSkillInvocation: () => "/list-tasks",
          } as unknown as AgentRuntime,
        ],
      ]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry, fixtures: true });
    const res = await post(app, { skill_id: SKILL_ID });
    const body = (await res.json()) as Record<string, unknown>;
    // Only { ok: true } — no result, no skill data, no trigger
    expect(Object.keys(body)).toEqual(["ok"]);
  });

  test("gated-review actions write a normal text request into the model session", async () => {
    let capturedText: string | null = null;
    let capturedCommand: boolean | undefined;
    const session = makeSession({
      writeInput: async (text, opts) => {
        capturedText = text;
        capturedCommand = opts?.command;
      },
    });
    const runtime: Partial<AgentRuntime> = {
      id: "claude-code",
      discoverSkills: () => Promise.resolve(gatedReviewSkills("claude-code")),
      formatSkillInvocation: (skill, args) => {
        const request = formatMcpSkillRequest(skill, args);
        if (request === null) throw new Error("expected MCP skill");
        return request;
      },
    };
    const registry: RuntimeRegistry = {
      runtimes: new Map([["claude-code", runtime as AgentRuntime]]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry });

    const res = await post(app, {
      skill_id: "cc:mcp:gated-review:get_review_round",
      args: { pullRequestNumber: "373", includeResolved: "false" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(capturedText as unknown as string).toBe(
      'Use the gated-review MCP tool get_review_round with these arguments: {"pullRequestNumber":"373","includeResolved":"false"}.',
    );
    expect(capturedCommand).toBe(false);
  });

  test("clear and compact actions stay on the native command path", async () => {
    const captured: Array<{ text: string; command: boolean | undefined }> = [];
    const session = makeSession({
      writeInput: async (text, opts) => {
        captured.push({ text, command: opts?.command });
      },
    });
    const builtins: Skill[] = ["clear", "compact"].map((name) => ({
      id: `cc:builtin:${name}`,
      name,
      description: `${name} session`,
      backend: "claude-code",
      scope: "system",
      args: [],
      user_invocable: true,
      model_invocable: false,
    }));
    const runtime: Partial<AgentRuntime> = {
      id: "claude-code",
      discoverSkills: () => Promise.resolve(builtins),
      formatSkillInvocation: (skill) => `/${skill.name}`,
    };
    const registry: RuntimeRegistry = {
      runtimes: new Map([["claude-code", runtime as AgentRuntime]]),
      defaultId: "claude-code",
    };
    const app = buildRoutesApp({ session, registry });

    const clearResponse = await post(app, { skill_id: "cc:builtin:clear" });
    const compactResponse = await post(app, { skill_id: "cc:builtin:compact" });

    expect(clearResponse.status).toBe(200);
    expect(compactResponse.status).toBe(200);
    expect(captured).toEqual([
      { text: "/clear", command: true },
      { text: "/compact", command: true },
    ]);
  });
});
