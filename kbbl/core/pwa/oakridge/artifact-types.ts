import type { JsonValue } from "./types";

export interface ArtifactRevision {
  id: string;
  status: ArtifactRevisionStatus;
  created_at: string;
  body: JsonValue;
  validation: unknown;
}

/** Mirrors the revision status returned by the artifact API. */
export type ArtifactRevisionStatus = "unreviewed" | "accepted" | "changes_requested";
/** Mirrors `FindingSeverity` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export type FindingSeverity = "blocking" | "warning" | "info";
/** Mirrors `AssessmentVerdict` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export type AssessmentVerdict = "pass" | "pass_with_notes" | "fail";
/** Mirrors `PrReviewStatus` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export type PrReviewStatus = "draft" | "ready" | "changes_requested" | "approved" | "merged" | "closed";

export interface ArtifactCapabilities {
  reviewable: boolean;
  commentable: boolean;
  atom_editable: boolean;
  review_items: boolean;
}

export interface ArtifactReviewDescriptor {
  viewer: string;
  layout: "document" | "dag" | "report";
  sections: string[];
  action_labels: Record<string, string>;
  action_consequences?: Record<string, string>;
}

export interface ArtifactTypeDescriptor {
  id: string;
  component_id: string;
  capabilities: ArtifactCapabilities;
  anchor_schema: string[] | null;
  review?: ArtifactReviewDescriptor | null;
}

export interface ArtifactDetail {
  review_error?: { readonly detail: string } | null;
  review_context?: import("./review-command-types").OperatorArtifactReviewContext | null;
  id: string;
  type_id: string;
  component_id: string | null;
  capabilities: ArtifactCapabilities | null;
  anchor_schema: string[] | null;
  review?: ArtifactReviewDescriptor | null;
  run_id: string;
  producing_stage: string;
  label?: string | null;
  revisions: ArtifactRevision[];
}

