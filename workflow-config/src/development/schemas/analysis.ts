import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const analysisSchemas: Schema[] = [
  recordSchema("risk", [field("description", "text"), field("mitigation", "text")]),
  { key: "risks", shape: { kind: "list", item: "risk", max_items: 100 } },
  recordSchema("issue", [field("description", "text"), field("severity", "severity")]),
  { key: "issues", shape: { kind: "list", item: "issue", max_items: 100 } },
  recordSchema("spec_finding", [field("id", "ident"), field("description", "text"), field("severity", "severity")]),
  { key: "spec_findings", shape: { kind: "list", item: "spec_finding", max_items: 100 } },
  { key: "requirement_status", shape: { kind: "enum", variants: ["implementable", "blocked", "ambiguous"] } },
  recordSchema("requirement", [field("id", "ident"), field("description", "text"), field("status", "requirement_status")]),
  { key: "requirements", shape: { kind: "list", item: "requirement", max_items: 100 } },
  recordSchema("analysis_body", [
    field("summary", "text"),
    field("source_spec_refs", "texts"),
    field("findings", "spec_findings"),
    field("requirements", "requirements"),
    field("risks", "risks")
  ]),
  { key: "optional_analysis", shape: { kind: "optional", item: "analysis_body" } },
];
