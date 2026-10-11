import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle, Snapshot } from "../src/core-client/generated-contracts";

const root = resolve(import.meta.dir, "../..");
const paths = ["development.json", "development-independent-siblings.json"] as const;
const bundles: DefinitionBundle[] = await Promise.all(paths.map((path) => Bun.file(resolve(root, "workflow-config/definitions", path)).json()));
const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };

test("both policy and capacity variants compile through the same binary", async () => {
  const started = CoreClient.start({ binary: resolve(root, "workflow-core/target/debug/workflow-cli"), deadlineMs: 5_000 });
  if (!started.ok) throw new Error(started.error.detail.detail);
  const core = started.value;
  try {
    const config = { runtime: "codex", workdir: "/tmp", session_name: "development" };
    for (const bundle of bundles) {
      const result = await core.request("compile", { bundle });
      expect(result.ok).toBe(true);
    }
    expect(bundles.map((bundle) => bundle.scopes.find((scope) => scope.key === "implementation")?.pools[0]?.limit)).toEqual([4, 2]);
    const outcomes = [];
    for (const bundle of bundles) {
      const validated = await core.request("validate_payload", { bundle, schema: "run_input",
        payload: { spec: "Implement feature", repositories: [], analysis: config, planning: config, briefs: config, admission: {}, final_merge_policy: "require_merge" } });
      if (!validated.ok || validated.value.kind !== "validated") throw new Error(JSON.stringify(validated));
      const snapshot: Snapshot = { owner: "root", scope: "development", version: 1, input: validated.value.value,
        state: { schema: "phase_root", data: { kind: "variant", variant: "implementing", value: unit } },
        trigger: { id: "failed", key: "implementation_finished", payload: unit }, observations: [
          { identity: "outcomes", version: 1, root: { kind: "children_outcomes", key: "implementation", schema: "results" }, value: { schema: "results", data: { kind: "list", items: [{ schema: "result", data: { kind: "variant", variant: "failed", value: unit } }] } } },
          { identity: "complete", version: 1, root: { kind: "children_complete", key: "implementation", schema: "flag" }, value: { schema: "flag", data: { kind: "boolean", value: false } } },
        ], timestamp_ms: 1, random_seed: 1 };
      const result = await core.request("evaluate", { bundle, snapshot });
      expect(result.ok).toBe(true);
      outcomes.push(result.ok && result.value.kind === "evaluated" && result.value.value.kind === "apply"
        ? result.value.value.outcome?.data.kind === "variant" ? result.value.value.outcome.data.variant : "continuing" : result.ok && result.value.kind === "evaluated" && result.value.value.kind === "wait" ? "continuing" : "error");
    }
    expect(outcomes).toEqual(["failed", "continuing"]);
  } finally { core.close(); }
});
