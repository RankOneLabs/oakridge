import { describe, expect, test } from "bun:test";

import {
  GATED_REVIEW_TOOL_SPECS,
  gatedReviewSkills,
  prepareGatedReviewArguments,
  repositoryFromRemote,
} from "./gated-review";

describe("gated-review tool catalog", () => {
  test("exposes every tool from the server schema with canonical names", () => {
    expect(GATED_REVIEW_TOOL_SPECS.map((tool) => tool.name)).toEqual([
      "review.get_state",
      "review.list_actions",
      "open_pr",
      "reply_to_thread",
      "resolve_thread",
      "request_next_round",
      "git.push",
      "git.pull",
      "git.fetch",
      "get_review_round",
      "pr_status",
    ]);
    expect(gatedReviewSkills("codex").every((skill) => skill.args.length > 0)).toBe(
      true,
    );
  });

  test("parses HTTPS and SSH origin URLs into repository names", () => {
    expect(repositoryFromRemote("https://github.com/RankOneLabs/oakridge.git")).toBe(
      "RankOneLabs/oakridge",
    );
    expect(repositoryFromRemote("git@github.com:RankOneLabs/oakridge.git")).toBe(
      "RankOneLabs/oakridge",
    );
  });
});

describe("prepareGatedReviewArguments", () => {
  const gitContextResolver = async () => ({
    repository: "RankOneLabs/oakridge",
    branch: "kbbl/direct-mcp",
  });

  test("coerces integer arguments and derives repository", async () => {
    const result = await prepareGatedReviewArguments({
      toolName: "pr_status",
      rawArgs: { pullRequestNumber: "373" },
      workdir: "/repo/worktree",
      gitContextResolver,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        repository: "RankOneLabs/oakridge",
        pullRequestNumber: 373,
      },
    });
  });

  test("derives open-PR base and head while preserving typed draft", async () => {
    const result = await prepareGatedReviewArguments({
      toolName: "open_pr",
      rawArgs: {
        base: "",
        head: "",
        title: "Direct MCP",
        body: "",
        draft: "true",
      },
      workdir: "/repo/worktree",
      gitContextResolver,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        repository: "RankOneLabs/oakridge",
        base: "main",
        head: "kbbl/direct-mcp",
        title: "Direct MCP",
        draft: true,
      },
    });
  });

  test("rejects malformed integer input before invoking MCP", async () => {
    const result = await prepareGatedReviewArguments({
      toolName: "get_review_round",
      rawArgs: { pullRequestNumber: "three" },
      workdir: "/repo/worktree",
      gitContextResolver,
    });

    expect(result).toEqual({
      ok: false,
      error: "pullRequestNumber must be an integer",
    });
  });
});
