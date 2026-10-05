import { expect, test } from "bun:test";
import { resolve } from "node:path";
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
  const result = await core.request("validate_payload", { bundle, available_operations: bundle.operations, schema, payload });
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
    const result = await core.request("compile", { bundle, available_operations: bundle.operations });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("compiled");
  } finally { core.close(); }
});

test("selected prompt carries its pinned action input", () => {
  expect(promptWithActionInput("Review this build", { feedback: "fix scope", revision: "build-2" }))
    .toContain('"revision": "build-2"');
});

test("root selects repository preparation and build feedback selects a new build action", async () => {
  const core = client();
  try {
    const config = { runtime: "codex", workdir: "/tmp", session_name: "development" };
    const root_input = await checked(core, "run_input", { repository: { repository_path: "/tmp", expected_head: null },
      analysis: config, planning: config, briefs: config, implementation: [], integration: config });
    const root_result = await core.request("evaluate", { bundle, available_operations: bundle.operations,
      snapshot: snapshot("development", root_input, "phase_simple", "ready", "begin") });
    expect(root_result.ok && root_result.value.kind === "evaluated" && root_result.value.value.kind === "apply"
      ? root_result.value.value.mutations.some((mutation) => mutation.kind === "activate_child" && mutation.key === "prepare") : false).toBe(true);

    const revision = (id: string): CheckedValue => ({ schema: "revision", data: { kind: "reference", brand: "artifact_revision", id } });
    const build_result = revision("build-2");
    const pr_summary = revision("pr-2");
    const target: CheckedValue = { schema: "build_target", data: { kind: "record", fields: [
      { field_id: 0, value: build_result }, { field_id: 1, value: pr_summary }], dictionary: [] } };
    const observations: Snapshot["observations"] = [
      { identity: "build-result", version: 2, root: { kind: "output", key: "build_result" }, value: build_result },
      { identity: "pr-summary", version: 2, root: { kind: "output", key: "pr_summary" }, value: pr_summary },
    ];
    const revised = await core.request("evaluate", { bundle, available_operations: bundle.operations,
      snapshot: snapshot("implementation", await checked(core, "session_config", config), "phase_impl", "review", "request_build_changes", target, observations) });
    expect(revised.ok && revised.value.kind === "evaluated" && revised.value.value.kind === "apply"
      ? revised.value.value.invocations.some((invocation) => invocation.selection.action === "revise") : false).toBe(true);
  } finally { core.close(); }
});
