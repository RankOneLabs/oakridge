import { describe, expect, test } from "bun:test";

import {
  formatMcpSkillRequest,
  GATED_REVIEW_TOOL_SPECS,
  gatedReviewSkills,
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

  test("formats a rail selection as a model-visible request with arguments", () => {
    const skill = gatedReviewSkills("codex").find(
      (candidate) => candidate.id === "codex:mcp:gated-review:get_review_round",
    );
    if (skill === undefined) throw new Error("missing get_review_round fixture");

    expect(
      formatMcpSkillRequest(skill, {
        pullRequestNumber: "373",
        includeResolved: "false",
      }),
    ).toBe(
      'Use the gated-review MCP tool get_review_round with these arguments: {"pullRequestNumber":"373","includeResolved":"false"}.',
    );
  });

  test("omits undeclared and whitespace-only arguments from the request", () => {
    const skill = gatedReviewSkills("claude-code").find(
      (candidate) => candidate.id === "cc:mcp:gated-review:git.fetch",
    );
    if (skill === undefined) throw new Error("missing git.fetch fixture");

    expect(
      formatMcpSkillRequest(skill, {
        refspec: "   ",
        repository: "attacker/repository",
        repo_path: "/tmp/attacker-worktree",
      }),
    ).toBe(
      "Use the gated-review MCP tool git.fetch.",
    );
  });
});
