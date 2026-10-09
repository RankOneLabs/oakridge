import type { Schema } from "../../source-contracts";
import { field, optionalField, recordSchema } from "../../primitives/schemas";

export const executionSchemas: Schema[] = [
  recordSchema("task_input", [
    field("config", "session_config"),
    field("spec", "text"),
    field("repositories", "repository_configs"),
    field("repository_refs", "repository_refs"),
    field("analysis", "optional_analysis"),
    field("plan", "optional_plan")
  ]),
  { key: "optional_task", shape: { kind: "optional", item: "task_input" } },
  recordSchema("implementation_input", [field("brief", "brief_body"), field("repository", "repository_config"), field("push_remote_owner", "ident")]),
  { key: "optional_implementation", shape: { kind: "optional", item: "implementation_input" } },
  recordSchema("completed_work", [field("repository_key", "ident"), field("pr_url", "text"), field("head_sha", "ident"), field("branch", "ident")]),
  { key: "completed_works", shape: { kind: "list", item: "completed_work", max_items: 100 } },
  recordSchema("integration_input", [
    field("repository_key", "ident"),
    field("config", "session_config"),
    field("completed_work", "completed_works"),
    field("forge", "forge_config"),
    field("push_remote_owner", "ident")
  ]),
  { key: "optional_integration", shape: { kind: "optional", item: "integration_input" } },
  recordSchema("integration_seed", [field("repository_key", "ident"), field("config", "session_config"), field("forge", "forge_config"), field("push_remote_owner", "ident")]),
  { key: "integration_seeds", shape: { kind: "list", item: "integration_seed", max_items: 100 } },
  recordSchema("session_context", [
    optionalField("task", "optional_task"),
    optionalField("implementation", "optional_implementation"),
    optionalField("integration", "optional_integration"),
    optionalField("feedback", "optional_text"),
    optionalField("accepted_build", "optional_build_target"),
    optionalField("build_result", "optional_build_body"),
    optionalField("pr_summary", "optional_pr_body"),
    optionalField("assessment", "optional_assessment_body"),
    optionalField("retained_build", "optional_revision"),
    optionalField("retained_pr", "optional_revision")
  ]),
  recordSchema("session_action", [field("selector", "session_selector"), field("config", "session_config"), field("context", "session_context")]),
  {
    key: "result",
    shape: {
      kind: "union",
      variants: [{ key: "complete", schema: "unit" }, { key: "failed", schema: "unit" }, { key: "cancelled", schema: "unit" }]
    }
  },
  { key: "results", shape: { kind: "list", item: "result", max_items: 100 } },
  recordSchema("failure_summary", [field("failures", "results"), field("prior_failures", "results")]),
  {
    key: "run_result",
    shape: {
      kind: "union",
      variants: [{ key: "complete", schema: "unit" }, { key: "failed", schema: "failure_summary" }, { key: "cancelled", schema: "unit" }]
    }
  },
  {
    key: "phase_root",
    shape: {
      kind: "union",
      variants: [
        { key: "ready", schema: "unit" },
        { key: "preparing", schema: "unit" },
        { key: "analyzing", schema: "unit" },
        { key: "planning", schema: "unit" },
        { key: "briefing", schema: "unit" },
        { key: "implementing", schema: "unit" },
        { key: "integrating", schema: "unit" }
      ]
    }
  },
  {
    key: "phase_review",
    shape: { kind: "union", variants: [{ key: "ready", schema: "unit" }, { key: "working", schema: "unit" }, { key: "review", schema: "unit" }] }
  },
  { key: "phase_simple", shape: { kind: "union", variants: [{ key: "ready", schema: "unit" }, { key: "working", schema: "unit" }] } },
  {
    key: "phase_impl",
    shape: {
      kind: "union",
      variants: [
        { key: "ready", schema: "unit" },
        { key: "working", schema: "unit" },
        { key: "review", schema: "unit" },
        { key: "assessing", schema: "build_target" },
        { key: "assessment_review", schema: "build_target" },
        { key: "discussing", schema: "assessment_target" },
        { key: "awaiting_merge", schema: "assessment_target" }
      ]
    }
  },
  {
    key: "phase_final",
    shape: {
      kind: "union",
      variants: [{ key: "ready", schema: "unit" }, { key: "working", schema: "unit" }, { key: "review", schema: "final_target" }]
    }
  },
];
