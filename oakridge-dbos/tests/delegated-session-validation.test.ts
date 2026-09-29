import { expect, test } from "bun:test";

import { delegatedSessionDefinitionSchema, validateDelegatedSessionCardinality, validateDelegatedSessionContracts } from "../src/validation/delegated-session";
import type { DelegatedSessionDefinitionConfig } from "../src/domain/delegated-session";

const definition = {
  prompt_matrix: ["initial", "operator_retry", "input_revision"].map((launch_reason) => ({ session_role: "build", launch_reason, template_path: "prompts/example.md" })),
  role_configs: [{ session_role: "build", runtime: "claude-code", session_name: "example", authorized_outputs: ["result"] }],
  slot_bindings: {},
  workdir: { from: "literal" as const, value: "." },
  artifact_productions: [],
  handoffs: [],
  gates: [{
    name: "result_gate",
    outputs: ["result"],
    steps: [
      { type: "artifact_approval" as const, actions: ["approve"] },
      { type: "artifact_approval" as const, actions: ["approve"] },
    ],
  }],
};

/**
 * A gate action with no disposition used to validate and compile cleanly, then
 * behave as a rejection at runtime — failing the stage with
 * `required_output_missing` long after the definition was accepted.
 */
test("a gate action with no known disposition is refused at definition time", () => {
  const result = delegatedSessionDefinitionSchema.safeParse({
    ...definition,
    gates: [{ name: "result_gate", outputs: ["result"], steps: [{ type: "artifact_approval" as const, actions: ["approve", "accept"] }] }],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain("action 'accept' has no known disposition");
});

test("the built-in action vocabulary validates", () => {
  const result = delegatedSessionDefinitionSchema.safeParse({
    ...definition,
    gates: [{ name: "result_gate", outputs: ["result"], steps: [
      { type: "artifact_approval" as const, actions: ["approve", "request_revision"] },
      { type: "merge_confirmation" as const, actions: ["confirm_merged", "closed_without_merge"] },
    ] }],
  });
  expect(result.success).toBe(true);
});

test("delegated session validation rejects duplicate durable gate step identities", () => {
  const result = delegatedSessionDefinitionSchema.safeParse(definition);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message)).toContain("output_gate step type 'artifact_approval' must be unique");
});

const fanOutDefinition = (fanOut: Record<string, unknown>) => ({
  prompt_matrix: ["initial", "operator_retry", "input_revision"].map((launch_reason) => ({ session_role: "build", launch_reason, template_path: "prompts/example.md" })),
  role_configs: [{ session_role: "build", runtime: "claude-code", session_name: "example", authorized_outputs: ["result"] }],
  slot_bindings: {},
  workdir: { from: "literal" as const, value: "." },
  artifact_productions: [], gates: [], handoffs: [],
  fan_out: { over: { from: "input" as const, input_name: "units" }, unit_id_path: "/id", ...fanOut },
});

test("delegated session validation accepts per-role worktree with inherited input configured separately", () => {
  const result = delegatedSessionDefinitionSchema.safeParse(fanOutDefinition({
    inherit_worktree_from: "build",
  }));
  expect(result.success).toBe(true);
});

test("delegated session validation accepts a unit that inherits a worktree without cutting one", () => {
  expect(delegatedSessionDefinitionSchema.safeParse(fanOutDefinition({ inherit_worktree_from: "build" })).success).toBe(true);
});

test("plural contracts report duplicate keys and every missing prompt in one pass", () => {
  const parsed = delegatedSessionDefinitionSchema.parse({ ...definition,
    prompt_matrix: [{ session_role: "build", launch_reason: "initial", template_path: "one.md" },
      { session_role: "build", launch_reason: "initial", template_path: "two.md" }],
    gates: [{ name: "review", outputs: ["result"], steps: [] }, { name: "review", outputs: ["result"], steps: [] }],
  }) as DelegatedSessionDefinitionConfig;
  const diagnostics = [...validateDelegatedSessionCardinality("build", "build", parsed),
    ...validateDelegatedSessionContracts("build", "build", ["result"], parsed)];
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "duplicate_key", array: "prompt_matrix", key: "build:initial" }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "prompt_not_total", session_role: "build", launch_reason: "operator_retry" }));
  expect(diagnostics.filter((diagnostic) => diagnostic.kind === "gate_without_closer")).toHaveLength(2);
});

test("two gates and two handoffs are valid plural terminal policies", () => {
  const parsed = delegatedSessionDefinitionSchema.safeParse({ ...definition,
    gates: [{ name: "first", outputs: ["one"], steps: [{ type: "artifact_approval", actions: ["approve"] }] },
      { name: "second", outputs: ["two"], steps: [{ type: "artifact_approval", actions: ["approve"] }] }],
    handoffs: [{ name: "third", outputs: ["three"], downstream_role: "assessment", approved_wait: { kind: "review", close_events: ["approved"] } },
      { name: "fourth", outputs: ["four"], downstream_role: "assessment", approved_wait: { kind: "review", close_events: ["approved"] } }],
  });
  expect(parsed.success).toBe(true);
});

test("a required output with no authorized producer reports its stage and output", () => {
  const parsed = delegatedSessionDefinitionSchema.parse({ ...fanOutDefinition({}),
    role_configs: [{ session_role: "build", runtime: "claude-code", session_name: "example", authorized_outputs: [] }],
  }) as DelegatedSessionDefinitionConfig;
  expect(validateDelegatedSessionContracts("build", "build", ["result"], parsed)).toContainEqual(expect.objectContaining({
    kind: "output_producer_count", stage_key: "build", output: "result", producers: 0,
  }));
});

test("a handoff wait with no closing event reports the handoff", () => {
  const parsed = delegatedSessionDefinitionSchema.parse({ ...fanOutDefinition({}),
    handoffs: [{ name: "review", outputs: ["result"], downstream_role: "assessment", approved_wait: { kind: "github_review", close_events: [] } }],
  }) as DelegatedSessionDefinitionConfig;
  expect(validateDelegatedSessionContracts("build", "build", ["result"], parsed)).toContainEqual(expect.objectContaining({
    kind: "wait_without_closing_event", stage_key: "build", wait: "review",
  }));
});

test("the selected operator role must have a runtime and prompt contract", () => {
  const parsed = delegatedSessionDefinitionSchema.parse(fanOutDefinition({})) as DelegatedSessionDefinitionConfig;
  expect(validateDelegatedSessionContracts("build", "assessment", ["result"], parsed)).toContainEqual(expect.objectContaining({
    kind: "selected_role_missing", stage_key: "build", session_role: "assessment", contract_item: "operator_role",
  }));
});
