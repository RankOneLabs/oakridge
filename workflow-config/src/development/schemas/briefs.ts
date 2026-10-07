import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const briefsSchemas: Schema[] = [
  recordSchema("brief_decision", [field("decision", "text"), field("rationale", "text")]),
  { key: "brief_decisions", shape: { kind: "list", item: "brief_decision", max_items: 100 } },
  recordSchema("rejected_approach", [field("approach", "text"), field("reason", "text")]),
  { key: "rejected_approaches", shape: { kind: "list", item: "rejected_approach", max_items: 100 } },
  recordSchema("brief_body", [
    field("cohort_id", "ident"),
    field("repository_key", "ident"),
    field("title", "text"),
    field("depends_on", "ids"),
    field("goal", "text"),
    field("files_in_scope", "texts"),
    field("decisions_made", "brief_decisions"),
    field("approaches_rejected", "rejected_approaches"),
    field("acceptance_criteria", "texts"),
    field("next_action", "text")
  ]),
  { key: "brief_bodies", shape: { kind: "list", item: "brief_body", max_items: 100 } },
];
