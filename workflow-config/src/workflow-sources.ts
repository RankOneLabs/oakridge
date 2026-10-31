/**
 * Each authored workflow, by the name of the JSON derived from it under
 * `workflow-core/fixtures/bundles/`, and the YAML it is written in.
 */
export const WORKFLOW_SOURCES = {
  "review-loop": "workflow-config/samples/review-loop.yaml",
  "fan-out": "workflow-config/samples/fan-out.yaml",
  development: "workflow-config/development.yaml",
} as const;

/** The workflows a deployed backend launches: each is pinned from its committed JSON at boot, and no other definition is launchable. */
export const LAUNCHABLE_WORKFLOWS = ["development"] as const satisfies readonly (keyof typeof WORKFLOW_SOURCES)[];
