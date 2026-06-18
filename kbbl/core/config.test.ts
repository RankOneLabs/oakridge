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

describe("sessions.default_allowlist", () => {
  test("defaults to read-only tools plus Bash when omitted", () => {
    const r = KbblConfigSchema.parse({});
    expect(r.sessions.default_allowlist).toEqual(["Read", "Glob", "Grep", "Bash"]);
  });

  test("an explicit list overrides the default (incl. empty = approve everything)", () => {
    expect(
      KbblConfigSchema.parse({ sessions: { default_allowlist: [] } }).sessions
        .default_allowlist,
    ).toEqual([]);
    expect(
      KbblConfigSchema.parse({ sessions: { default_allowlist: ["Read"] } }).sessions
        .default_allowlist,
    ).toEqual(["Read"]);
  });
});
