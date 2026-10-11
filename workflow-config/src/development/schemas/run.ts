import type { Schema, SchemaField } from "../../source-contracts";
import { field, optionalField, recordSchema } from "../../primitives/schemas";

/** Shared root fields keep the verification variant's launch contract in sync. */
export const runInputFields: SchemaField[] = [
  field("spec", "text"),
  field("repositories", "repository_configs"),
  field("analysis", "session_config"),
  field("planning", "session_config"),
  field("briefs", "session_config"),
  optionalField("title", "text"),
  optionalField("slug", "ident"),
  field("final_merge_policy", "final_merge_policy"),
  optionalField("base_branch", "ident"),
  optionalField("sessions", "run_sessions"),
  field("admission", "admission_flags")
];

export const runSchemas: Schema[] = [
  recordSchema("run_input", runInputFields),
  { key: "final_merge_policy", shape: { kind: "enum", variants: ["require_merge", "allow_close_without_merge"] } },
  { key: "optional_runtime", shape: { kind: "optional", item: "runtime" } },
  recordSchema("session_settings", [field("runtime", "optional_runtime"), field("model", "optional_ident"), field("effort", "optional_ident")]),
  recordSchema("run_sessions", [
    optionalField("planner", "session_settings"), optionalField("worker", "session_settings"),
    optionalField("spec_analysis", "session_settings"), optionalField("planning", "session_settings"),
    optionalField("brief_writing", "session_settings"), optionalField("implementation", "session_settings"),
    optionalField("final_integration", "session_settings")
  ]),
  recordSchema("admission_flags", [
    optionalField("spec_analysis", "flag"), optionalField("planning", "flag"),
    optionalField("brief_writing", "flag"), optionalField("implementation", "flag"),
    optionalField("final_integration", "flag")
  ]),
  recordSchema("prepare_member", [field("key", "ident"), field("input", "repo_input"), field("dependencies", "ids")]),
  { key: "prepare_members", shape: { kind: "list", item: "prepare_member", max_items: 100 } },
  recordSchema("implementation_member", [field("key", "ident"), field("input", "implementation_input"), field("dependencies", "ids")]),
  { key: "implementation_members", shape: { kind: "list", item: "implementation_member", max_items: 100 } },
  recordSchema("integration_member", [field("key", "ident"), field("input", "integration_input"), field("dependencies", "ids")]),
  { key: "integration_members", shape: { kind: "list", item: "integration_member", max_items: 100 } },
  recordSchema("brief_feedback", [field("revisions", "revisions"), field("text", "text")]),
];
