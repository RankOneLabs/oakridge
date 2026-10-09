import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const implementationSchemas: Schema[] = [
  recordSchema("test_evidence", [
    field("passed", "count"),
    field("failed", "count"),
    field("output", "optional_text"),
    field("summary", "optional_text"),
    field("cargo_test_output", "optional_text")
  ]),
  { key: "optional_tests", shape: { kind: "optional", item: "test_evidence" } },
  recordSchema("build_metadata", [field("cohort_id", "optional_ident"), field("session_id", "optional_ident"), field("branch", "optional_ident")]),
  { key: "optional_build_metadata", shape: { kind: "optional", item: "build_metadata" } },
  recordSchema("build_body", [
    field("repository_key", "optional_ident"),
    field("summary", "text"),
    field("changed_files", "texts"),
    field("tests", "test_evidence"),
    field("delegated_session_metadata", "optional_build_metadata"),
    field("known_issues", "issues")
  ]),
  recordSchema("assessment_finding", [
    field("criterion", "optional_text"),
    field("status", "optional_criterion_status"),
    field("evidence", "optional_text"),
    field("description", "optional_text")
  ]),
  { key: "assessment_findings", shape: { kind: "list", item: "assessment_finding", max_items: 100 } },
  recordSchema("assessment_body", [
    field("verdict", "verdict"),
    field("findings", "assessment_findings"),
    field("test_evidence", "optional_tests"),
    field("recommended_next_actions", "texts")
  ]),
  { key: "pr_review_status", shape: { kind: "enum", variants: ["draft", "ready", "changes_requested", "approved", "merged", "closed"] } },
  { key: "optional_pr_review_status", shape: { kind: "optional", item: "pr_review_status" } },
  recordSchema("pr_body", [field("pr_url", "text"), field("branch", "ident"), field("summary", "text"), field("review_status", "optional_pr_review_status")]),
];
