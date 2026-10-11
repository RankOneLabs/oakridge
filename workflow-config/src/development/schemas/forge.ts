import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const forgeSchemas: Schema[] = [
  recordSchema("forge_config", [field("owner", "ident"), field("name", "ident"), field("build_base", "ident"), field("final_base", "ident")]),
  { key: "pr_number", shape: { kind: "integer", min: 1, max: 2147483647 } },
  { key: "forge_state", shape: { kind: "enum", variants: ["open", "merged", "closed", "closed_unmerged"] } },
  recordSchema("forge_observation", [
    field("provider", "text"),
    field("owner", "ident"),
    field("name", "ident"),
    field("number", "pr_number"),
    field("url", "text"),
    field("head_branch", "ident"),
    field("base_branch", "ident"),
    field("head_sha", "optional_ident"),
    field("state", "forge_state"),
    field("source", "text"),
    field("observed_at", "text"),
    field("merged_at", "optional_text")
  ]),
  { key: "forge_observations", shape: { kind: "list", item: "forge_observation", max_items: 100 } },
  recordSchema("pr_query", [
    field("owner", "ident"),
    field("name", "ident"),
    field("head_owner", "ident"),
    field("head_branch", "ident"),
    field("base_branch", "ident")
  ]),
  recordSchema("pr_observe_input", [field("query", "pr_query")]),
  recordSchema("pr_observe_result", [field("observations", "forge_observations")]),
  { key: "optional_repository_keys", shape: { kind: "list", item: "optional_ident", max_items: 100 } },
];
