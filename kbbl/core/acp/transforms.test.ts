import { expect, test } from "bun:test";

import type * as schema from "@agentclientprotocol/sdk";

import { buildAgentEnv } from "./agent-profile";
import { resolveRequestedOption } from "./controller";
import { projectSessionUpdate } from "./event-projector";

const OPTIONS: schema.SessionConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "fake-small",
    options: [
      { value: "fake-small", name: "Fake Small" },
      { value: "fake-large", name: "Fake Large" },
    ],
  },
];

test("buildAgentEnv exclude strips a variable even when inheriting", () => {
  const env = buildAgentEnv(
    { inherit: true, exclude: ["ANTHROPIC_API_KEY"] },
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-oops" },
  );
  expect(env.PATH).toBe("/usr/bin");
  expect("ANTHROPIC_API_KEY" in env).toBe(false);
});

test("buildAgentEnv set overrides win and inherit=false starts empty", () => {
  const env = buildAgentEnv(
    { inherit: false, set: { FAKE_ACP_BEHAVIOR: "happy" } },
    { PATH: "/usr/bin" },
  );
  expect(env).toEqual({ FAKE_ACP_BEHAVIOR: "happy" });
});

test("resolveRequestedOption matches by value id and by display name", () => {
  const byValue = resolveRequestedOption(OPTIONS, "model", "fake-large");
  expect(byValue.ok && byValue.value?.valueId).toBe("fake-large");
  const byName = resolveRequestedOption(OPTIONS, "model", "fake small");
  expect(byName.ok && byName.value?.valueId).toBe("fake-small");
});

test("resolveRequestedOption with nothing requested resolves to null", () => {
  const resolved = resolveRequestedOption(OPTIONS, "model", null);
  expect(resolved.ok && resolved.value).toBeNull();
});

test("resolveRequestedOption fails when no selector exists for the category", () => {
  const resolved = resolveRequestedOption(OPTIONS, "thought_level", "high");
  expect(!resolved.ok && resolved.error.code).toBe(
    "requested_effort_unsupported",
  );
});

test("projectSessionUpdate maps agent chunks and returns null for unknown updates", () => {
  const projected = projectSessionUpdate(
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
    false,
    "chunk-1",
  );
  expect(projected?.kind).toBe("agent_message");
  expect(projected && "id" in projected ? projected.id : null).toBe("chunk-1");

  const unknown = projectSessionUpdate(
    {
      sessionUpdate: "compaction_update",
      compactionId: "c1",
      status: "in_progress",
    } as unknown as schema.SessionUpdate,
    false,
    "chunk-2",
  );
  expect(unknown).toBeNull();
});
