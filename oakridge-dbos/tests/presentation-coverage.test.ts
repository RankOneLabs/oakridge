import { expect, test } from "bun:test";
import { buildDevelopmentRun } from "../../workflow-config/src/development";
import { DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY } from "../../workflow-config/src/development/policies";
import { decisionKind, outputPresentation, stageLabel } from "../src/projections/presentation";

test("presentation lookups cover every output schema, scope key and scope state in all shipped bundles", () => {
  for (const policy of [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY]) {
    const bundle = buildDevelopmentRun(policy);
    for (const scope of bundle.scopes) {
      expect(stageLabel(scope.key)).toBe(scope.presentation.label);
      for (const output of scope.outputs) expect(outputPresentation(output.schema)).not.toBeNull();
      const state = bundle.schemas.find((schema) => schema.key === scope.state_schema)?.shape;
      if (state?.kind !== "union" && state?.kind !== "enum") throw new Error(`unsupported state schema for ${scope.key}`);
      const keys = state.kind === "union" ? state.variants.map((variant) => variant.key) : state.variants;
      for (const key of keys) expect(decisionKind(scope.key, key)).not.toBeNull();
    }
  }
});

test("unknown presentation keys have no fallback", () => {
  expect({ output: outputPresentation("new_output"), stage: stageLabel("new_scope"), decision: decisionKind("planning", "new_state") })
    .toEqual({ output: null, stage: null, decision: null });
});
