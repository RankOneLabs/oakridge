import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const planningSchemas: Schema[] = [
  recordSchema("plan_cohort", [
    field("id", "ident"),
    field("repository_key", "optional_ident"),
    field("title", "text"),
    field("scope", "text"),
    field("depends_on", "ids"),
    field("description", "optional_text"),
    field("files_in_scope", "texts"),
    field("decisions", "texts"),
    field("acceptance_criteria", "texts")
  ]),
  { key: "plan_cohorts", shape: { kind: "list", item: "plan_cohort", max_items: 100 } },
  recordSchema("plan_scope", [field("in_scope", "texts"), field("out_of_scope", "texts")]),
  recordSchema("plan_body", [
    field("summary", "text"),
    field("cohorts", "plan_cohorts"),
    field("dependency_order", "ids"),
    field("scope", "plan_scope"),
    field("acceptance_criteria", "texts"),
    field("risks", "risks")
  ]),
  { key: "optional_plan", shape: { kind: "optional", item: "plan_body" } },
];
