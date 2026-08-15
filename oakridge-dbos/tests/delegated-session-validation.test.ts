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
