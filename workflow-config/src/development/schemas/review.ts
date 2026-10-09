import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const reviewSchemas: Schema[] = [
  recordSchema("pr_observation", [field("pr_url", "text"), field("head_sha", "ident")]),
  {
    key: "repository_state",
    shape: {
      kind: "union",
      variants: [
        { key: "open", schema: "pr_observation" },
        { key: "merged", schema: "pr_observation" },
        { key: "closed_unmerged", schema: "pr_observation" }
      ]
    }
  },
  recordSchema("revision_target", [field("revision", "revision")]),
  recordSchema("feedback", [field("revision", "revision"), field("text", "text")]),
  recordSchema("build_target", [field("build_result", "revision"), field("pr_summary", "revision"), field("pr_url", "text"), field("head_sha", "ident")]),
  recordSchema("assessment_target", [
    field("assessment", "revision"),
    field("build_result", "revision"),
    field("pr_summary", "revision"),
    field("pr_url", "text"),
    field("head_sha", "ident")
  ]),
  recordSchema("build_feedback", [
    field("build_result", "revision"),
    field("pr_summary", "revision"),
    field("pr_url", "text"),
    field("head_sha", "ident"),
    field("text", "text")
  ]),
  recordSchema("assessment_feedback", [
    field("assessment", "revision"),
    field("build_result", "revision"),
    field("pr_summary", "revision"),
    field("pr_url", "text"),
    field("head_sha", "ident"),
    field("text", "text")
  ]),
  recordSchema("unchanged_target", [
    field("assessment", "revision"),
    field("build_result", "revision"),
    field("pr_summary", "revision"),
    field("pr_url", "text"),
    field("head_sha", "ident"),
    field("explanation", "text")
  ]),
  recordSchema("retry_build_target", [field("build_result", "optional_revision"), field("pr_summary", "optional_revision")]),
  recordSchema("final_target", [field("revision", "revision"), field("pr_url", "text"), field("head_sha", "ident")]),
  recordSchema("brief_review", [field("revisions", "revisions"), field("briefs", "brief_bodies")]),
];
