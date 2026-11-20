import { describe, expect, test } from "bun:test";

import { KbblConfigSchema } from "./config";

describe("sessions.worktree_dir_name validation", () => {
  // worktree_dir_name is joined directly onto dataDir, so anything that
  // looks like a path (separators, ..) could collapse worktrees into the
  // dataDir itself or escape it entirely. Validation lives in the schema
  // so a misconfigured config.json fails at startup, not at the first
  // worktree create.
  test("rejects empty string", () => {
    const r = KbblConfigSchema.safeParse({
      sessions: { worktree_dir_name: "" },
    });
    expect(r.success).toBe(false);
  });

  test("rejects '.'", () => {
    const r = KbblConfigSchema.safeParse({
      sessions: { worktree_dir_name: "." },
    });
    expect(r.success).toBe(false);
  });

  test("rejects '..'", () => {
    const r = KbblConfigSchema.safeParse({
      sessions: { worktree_dir_name: "../escape" },
    });
    expect(r.success).toBe(false);
  });

  test("rejects forward slash (path-like)", () => {
    const r = KbblConfigSchema.safeParse({
      sessions: { worktree_dir_name: "nested/dir" },
    });
    expect(r.success).toBe(false);
  });

  test("rejects backslash (Windows separator)", () => {
    const r = KbblConfigSchema.safeParse({
      sessions: { worktree_dir_name: "nested\\dir" },
    });
    expect(r.success).toBe(false);
  });

  test("accepts a simple name", () => {
    const r = KbblConfigSchema.safeParse({
      sessions: { worktree_dir_name: "my-worktrees" },
    });
    expect(r.success).toBe(true);
  });

  test("default is 'worktrees' when omitted", () => {
    const r = KbblConfigSchema.parse({});
    expect(r.sessions.worktree_dir_name).toBe("worktrees");
  });
});

describe("skills.confirm", () => {
  test("defaults to mutating gated-review MCP tools", () => {
    const r = KbblConfigSchema.parse({});
    expect(r.skills.confirm).toEqual([
      "mcp:gated-review:git.push",
      "mcp:gated-review:git.pull",
      "mcp:gated-review:open_pr",
    ]);
  });

  test("an explicit list overrides the default", () => {
    const r = KbblConfigSchema.parse({ skills: { confirm: ["deploy"] } });
    expect(r.skills.confirm).toEqual(["deploy"]);
  });
});

describe("acp.default_agent", () => {
  test("defaults to claude-code when omitted", () => {
    expect(KbblConfigSchema.parse({}).acp.default_agent).toBe("claude-code");
  });

  test("a removed top-level block fails the strict schema", () => {
    expect(KbblConfigSchema.safeParse({ runtime: { default: "codex" } }).success).toBe(false);
  });
});

test("PR installation settings are captured from config input, independently of later environment changes", async () => {
  const { loadPrIntegrationConfig } = await import("./config");
  const env = { OAKRIDGE_PR_INTEGRATION: "github-cli", OAKRIDGE_GATED_REVIEW_URL: "http://review/mcp" };
  const config = loadPrIntegrationConfig(env);
  env.OAKRIDGE_PR_INTEGRATION = "none";
  expect(config).toEqual({ default_integration: "github-cli", gated_review_url: "http://review/mcp" });
});

describe("ACP transcript retention configuration", () => {
  test("uses the agreed item and page defaults", () => {
    expect(KbblConfigSchema.parse({}).acp).toMatchObject({
      live_item_buffer: 5000, initial_item_window: 200, item_page_limit: 100, item_page_limit_max: 500,
    });
  });

  test.each([
    { item_page_limit_max: 501 },
    { live_item_buffer: 5, initial_item_window: 6 },
    { item_page_limit: 101, item_page_limit_max: 100 },
    { live_event_buffer: 2000 },
  ])("rejects invalid limits or the removed configuration key %j", (acp) => {
    expect(KbblConfigSchema.safeParse({ acp }).success).toBe(false);
  });
});
