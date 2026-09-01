import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { makeAcpTestService, type AcpTestHarness } from "../acp/test-harness";
import type { Skill } from "./types";
import { aggregateSkillsForProfile } from "./registry";
import { FIXTURE_SKILLS } from "./fixtures";
import { formatMcpSkillRequest, gatedReviewSkills } from "./gated-review";
import { formatSkillInvocation } from "./format";
import { mountSkillsRoutes } from "./routes";

const UNKNOWN_SID = "deadbeef-cafe-4abc-8def-aaaaaaaaaaaa";

function makeConfig(
  overrides: { hidden?: string[]; fixtures?: boolean; confirm?: string[] } = {},
): KbblConfig {
  return KbblConfigSchema.parse({
    skills: {
      hidden: overrides.hidden ?? [],
      fixtures: overrides.fixtures ?? false,
      confirm: overrides.confirm ?? [],
    },
  });
}

// === aggregateSkillsForProfile ===

describe("aggregateSkillsForProfile", () => {
  test("default source is the gated-review shortcuts for the profile", () => {
    const result = aggregateSkillsForProfile("claude-code", makeConfig());
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((s) => s.backend === "claude-code")).toBe(true);
    expect(result.every((s) => s.name.startsWith("mcp:gated-review:"))).toBe(true);
  });

  test("fixtures mode returns only skills matching the profile", () => {
    const config = makeConfig({ fixtures: true });
    const cc = aggregateSkillsForProfile("claude-code", config);
    expect(cc.every((s) => s.backend === "claude-code")).toBe(true);
    const codex = aggregateSkillsForProfile("codex", config);
    expect(codex.every((s) => s.backend === "codex")).toBe(true);
  });

  test("fixtures mode drops user_invocable=false skills", () => {
    const config = makeConfig({ fixtures: true });
    const result = aggregateSkillsForProfile("claude-code", config);
    const expectedCount = FIXTURE_SKILLS.filter(
      (s) => s.backend === "claude-code" && s.user_invocable !== false,
    ).length;
    expect(result).toHaveLength(expectedCount);
  });

  test("hidden denylist matches by name, not id", () => {
    const config = makeConfig({ fixtures: true, hidden: ["cc-list-tasks"] });
    const byId = aggregateSkillsForProfile("claude-code", config);
    expect(byId.some((s) => s.name === "list-tasks")).toBe(true);

    const byName = aggregateSkillsForProfile(
      "claude-code",
      makeConfig({ fixtures: true, hidden: ["list-tasks"] }),
    );
    expect(byName.every((s) => s.name !== "list-tasks")).toBe(true);
  });

  test("confirm annotation: allowlisted names get confirm=true, others false", () => {
    const config = makeConfig({ fixtures: true, confirm: ["deploy"] });
    const result = aggregateSkillsForProfile("claude-code", config);
    expect(result.find((s) => s.name === "deploy")?.confirm).toBe(true);
    expect(result.find((s) => s.name === "list-tasks")?.confirm).toBe(false);
  });

  test("default config gates mutating gated-review actions", () => {
    const result = aggregateSkillsForProfile(
      "claude-code",
      KbblConfigSchema.parse({}),
    );
    expect(
      result.find((s) => s.name === "mcp:gated-review:git.push")?.confirm,
    ).toBe(true);
    expect(
      result.find((s) => s.name === "mcp:gated-review:get_review_round")?.confirm,
    ).toBe(false);
  });

  test("a skill both hidden and confirm-listed stays hidden", () => {
    const config = makeConfig({
      fixtures: true,
      hidden: ["deploy"],
      confirm: ["deploy"],
    });
    const result = aggregateSkillsForProfile("claude-code", config);
    expect(result.every((s) => s.name !== "deploy")).toBe(true);
  });
});

// === formatSkillInvocation ===

describe("formatSkillInvocation", () => {
  const slashSkill: Skill = {
    id: "cc-foo",
    name: "foo",
    description: "",
    backend: "claude-code",
    scope: "user",
    args: [
      { key: "1", required: false, hint: "" },
      { key: "2", required: false, hint: "" },
      { key: "flag", required: false, hint: "" },
    ],
    user_invocable: true,
    model_invocable: false,
  };

  test("no args → bare slash trigger", () => {
    expect(formatSkillInvocation(slashSkill, {})).toBe("/foo");
  });

  test("positional args serialize in ascending numeric order", () => {
    expect(formatSkillInvocation(slashSkill, { "2": "b", "1": "a" })).toBe(
      "/foo a b",
    );
  });

  test("positional args precede named args; empty values dropped", () => {
    expect(
      formatSkillInvocation(slashSkill, { "1": "", flag: "named", "2": "val" }),
    ).toBe("/foo val named");
  });

  test("MCP skills format as a steering request, undeclared args stripped", () => {
    const skill = gatedReviewSkills("claude-code").find(
      (s) => s.name === "mcp:gated-review:get_review_round",
    )!;
    expect(
      formatSkillInvocation(skill, {
        pullRequestNumber: "373",
        includeResolved: "false",
        repository: "attacker/repository",
        repo_path: "/tmp/attacker-worktree",
      }),
    ).toBe(
      'Use the gated-review MCP tool get_review_round with these arguments: {"pullRequestNumber":"373","includeResolved":"false"}.',
    );
  });

  test("MCP skill with no provided args formats without an argument clause", () => {
    const skill = gatedReviewSkills("codex").find(
      (s) => s.name === "mcp:gated-review:git.fetch",
    )!;
    expect(formatMcpSkillRequest(skill, {})).toBe(
      "Use the gated-review MCP tool git.fetch.",
    );
  });
});

// === routes (over the real ACP service + fake agent) ===

describe("skills routes", () => {
  let tmpRoot: string;
  let harness: AcpTestHarness;
  let app: Hono;
  let sid: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "skills-routes-"));
    harness = makeAcpTestService({ stateDir: join(tmpRoot, "state") });
    app = new Hono();
    mountSkillsRoutes(app, {
      acp: harness.service,
      config: makeConfig({ fixtures: true }),
    });
    const created = await harness.service.createSession({
      initial_prompt: "",
      workdir: tmpRoot,
      runtime: "claude-code",
    });
    if (!created.ok) throw new Error(`createSession failed: ${created.error.detail}`);
    sid = created.value.sid;
  });

  afterAll(async () => {
    await harness.service.shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function post(target: string, body: unknown) {
    return app.fetch(
      new Request(`http://kbbl.test/sessions/${target}/skills/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("GET returns 400 for a malformed sid", async () => {
    const res = await app.fetch(
      new Request("http://kbbl.test/sessions/not-a-uuid/skills"),
    );
    expect(res.status).toBe(400);
  });

  test("GET returns [] for an unknown session", async () => {
    const res = await app.fetch(
      new Request(`http://kbbl.test/sessions/${UNKNOWN_SID}/skills`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET returns the profile's visible skills for a live session", async () => {
    const res = await app.fetch(
      new Request(`http://kbbl.test/sessions/${sid}/skills`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Skill[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((s) => s.backend === "claude-code")).toBe(true);
    expect(body.every((s) => s.user_invocable !== false)).toBe(true);
  });

  test("invoke on an unknown session is 404", async () => {
    const res = await post(UNKNOWN_SID, { skill_id: "cc-list-tasks" });
    expect(res.status).toBe(404);
  });

  test("invoke with a non-string arg value is 400", async () => {
    const res = await post(sid, { skill_id: "cc-list-tasks", args: { q: 7 } });
    expect(res.status).toBe(400);
  });

  test("invoke with an unknown skill id is 404", async () => {
    const res = await post(sid, { skill_id: "does-not-exist" });
    expect(res.status).toBe(404);
  });

  test("invoke with a missing required arg is 400", async () => {
    const res = await post(sid, { skill_id: "cc-create-pr", args: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /missing required arg/,
    );
  });

  test("invoke submits the formatted trigger as an operator turn", async () => {
    const res = await post(sid, { skill_id: "cc-list-tasks" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const turns = harness.db
      .query<{ payload: string; source: string }, [string]>(
        "SELECT payload, source FROM acp_turns WHERE sid = ? ORDER BY created_at DESC",
      )
      .all(sid);
    expect(turns.some((t) => t.payload === "/list-tasks" && t.source === "operator")).toBe(
      true,
    );
  });

  test("ended sessions list no skills", async () => {
    const created = await harness.service.createSession({
      initial_prompt: "",
      workdir: tmpRoot,
      runtime: "claude-code",
    });
    if (!created.ok) throw new Error("createSession failed");
    const closed = await harness.service.closeSession(created.value.sid);
    expect(closed.ok).toBe(true);
    const res = await app.fetch(
      new Request(`http://kbbl.test/sessions/${created.value.sid}/skills`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
