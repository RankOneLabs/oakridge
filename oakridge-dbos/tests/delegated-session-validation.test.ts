import { expect, test } from "bun:test";

import { delegatedSessionDefinitionSchema } from "../src/validation/delegated-session";

const definition = {
  runtime: "claude_code",
  prompt_template_path: "prompts/example.md",
  slot_bindings: {},
  workdir: { from: "literal" as const, value: "." },
  session_name: "example",
  output_gate: {
    output: "result",
    steps: [
      { type: "artifact_approval" as const, actions: ["approve"] },
      { type: "artifact_approval" as const, actions: ["approve"] },
    ],
  },
};

test("delegated session validation rejects duplicate durable gate step identities", () => {
  const result = delegatedSessionDefinitionSchema.safeParse(definition);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message)).toContain("output_gate step type 'artifact_approval' must be unique");
});

const fanOutDefinition = (fanOut: Record<string, unknown>) => ({
  runtime: "claude_code",
  prompt_template_path: "prompts/example.md",
  slot_bindings: {},
  workdir: { from: "literal" as const, value: "." },
  session_name: "example",
  fan_out: { over: { from: "input" as const, input_name: "units" }, unit_id_path: "/id", ...fanOut },
});

test("delegated session validation rejects a unit that both cuts and inherits a worktree", () => {
  const result = delegatedSessionDefinitionSchema.safeParse(fanOutDefinition({
    worktree: { branch_name: "cohort/x", worktree_subdir: "x" },
    inherit_worktree_from: "build",
  }));
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message)).toContain("fan_out.worktree and fan_out.inherit_worktree_from are mutually exclusive");
});

test("delegated session validation accepts a unit that inherits a worktree without cutting one", () => {
  expect(delegatedSessionDefinitionSchema.safeParse(fanOutDefinition({ inherit_worktree_from: "build" })).success).toBe(true);
});
