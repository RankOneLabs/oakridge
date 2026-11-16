/**
 * Each authored workflow, by the name of the JSON derived from it under
 * `workflow-core/fixtures/bundles/`, and the YAML it is written in.
 */
export const WORKFLOW_SOURCES = {
  "review-loop": { path: "workflow-config/samples/review-loop.yaml", audience: "test_fixture" },
  "fan-out": { path: "workflow-config/samples/fan-out.yaml", audience: "test_fixture" },
  development: { path: "workflow-config/development.yaml", audience: "user" },
} as const;
