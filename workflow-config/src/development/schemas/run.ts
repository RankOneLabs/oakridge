import type { Schema } from "../../source-contracts";
import { field, optionalField, recordSchema } from "../../primitives/schemas";

export const runSchemas: Schema[] = [
  recordSchema("run_input", [
    field("spec", "text"),
    field("repositories", "repository_configs"),
    field("analysis", "session_config"),
    field("planning", "session_config"),
    field("briefs", "session_config"),
    optionalField("title", "text"),
    optionalField("slug", "ident"),
    optionalField("final_merge_policy", "final_merge_policy")
  ]),
  { key: "final_merge_policy", shape: { kind: "enum", variants: ["require_merge", "allow_close_without_merge"] } },
  recordSchema("prepare_member", [field("key", "ident"), field("input", "repo_input"), field("dependencies", "ids")]),
  { key: "prepare_members", shape: { kind: "list", item: "prepare_member", max_items: 100 } },
  recordSchema("implementation_member", [field("key", "ident"), field("input", "implementation_input"), field("dependencies", "ids")]),
  { key: "implementation_members", shape: { kind: "list", item: "implementation_member", max_items: 100 } },
  recordSchema("integration_member", [field("key", "ident"), field("input", "integration_input"), field("dependencies", "ids")]),
  { key: "integration_members", shape: { kind: "list", item: "integration_member", max_items: 100 } },
  recordSchema("brief_feedback", [field("revisions", "revisions"), field("text", "text")]),
];
