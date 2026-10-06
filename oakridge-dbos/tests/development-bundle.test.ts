import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { repository } from "./development-runtime-fixture";
import { CoreClient } from "../src/core-client/client";
import { promptWithActionInput } from "../src/effects/operations/selected-request";
import type { CheckedValue, DefinitionBundle, Snapshot } from "../src/core-client/generated-contracts";

const root = resolve(import.meta.dir, "../..");
const bundle: DefinitionBundle = await Bun.file(resolve(root, "workflow-config/definitions/development.json")).json();
const binary = resolve(root, "workflow-core/target/debug/workflow-cli");
const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };

function client(): CoreClient {
  const result = CoreClient.start({ binary, deadlineMs: 5_000 });
  if (!result.ok) throw new Error(result.error.detail.detail);
  return result.value;
}

async function checked(core: CoreClient, schema: string, payload: unknown): Promise<CheckedValue> {
  const result = await core.request("validate_payload", { bundle, schema, payload });
  if (!result.ok || result.value.kind !== "validated") throw new Error(JSON.stringify(result));
  return result.value.value;
}

function snapshot(scope: string, input: CheckedValue, state_schema: string, state: string, trigger: string, payload: CheckedValue = unit,
  observations: Snapshot["observations"] = []): Snapshot {
  return { owner: `scope:${scope}`, scope, version: 1, input,
    state: { schema: state_schema, data: { kind: "variant", variant: state, value: unit } },
    trigger: { id: `trigger:${trigger}`, key: trigger, payload }, observations, timestamp_ms: 1, random_seed: 1 };
}

test("development declaration compiles against the generic core", async () => {
  const core = client();
  try {
    const result = await core.request("compile", { bundle });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("compiled");
  } finally { core.close(); }
});

test("selected prompt carries its pinned action input", () => {
  expect(promptWithActionInput("Review this build", { feedback: "fix scope", revision: "build-2" }))
    .toContain('"revision": "build-2"');
});

test("development prompt lookup preserves the rendered prompt bytes", () => {
  const action = bundle.scopes.flatMap((scope) => scope.workers.flatMap((worker) => worker.actions))
    .find((candidate) => candidate.prompt !== null && candidate.prompt !== undefined);
  const authored = bundle.prompts.find((prompt) => prompt.key === action?.prompt);
  if (!action?.prompt || !authored) throw new Error("development prompt fixture missing");
  const action_input = { repository: "oakridge", instruction: "Build the pinned scope" };
  const previous = promptWithActionInput(authored.content, action_input);
  const resolved = bundle.prompts.find((prompt) => prompt.key === action.prompt);
  expect(promptWithActionInput(resolved!.content, action_input)).toBe(previous);
});

test("root selects repository preparation from the repository configuration collection", async () => {
  const core = client();
  try {
    const config = { runtime: "codex", workdir: "/tmp", session_name: "development" };
    const root_input = await checked(core, "run_input", { spec: "Implement feature", repositories: [repository], analysis: config, planning: config, briefs: config });
    const result = await core.request("evaluate", { bundle,
      snapshot: snapshot("development", root_input, "phase_root", "ready", "begin") });
    expect(result).toMatchObject({ ok: true, value: { kind: "evaluated", value: { kind: "apply", mutations: expect.arrayContaining([expect.objectContaining({ kind: "activate_collection", key: "prepare" })]) } } });
  } finally { core.close(); }
});
