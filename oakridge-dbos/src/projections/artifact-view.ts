import type { ArtifactRevisionRecord, RunId, UnitId } from "../storage/schema-records";
import { outputPresentation, type ArtifactPresentation } from "./presentation";

/** Review status belongs to the operator projection, not the revision row. */
export type ArtifactRevisionStatus = "draft" | "approved" | "rejected";

export interface ArtifactDetail {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly artifact: string;
  readonly revision_id: string;
  readonly predecessor_id: string | null;
  readonly subject: string | null;
  readonly body: unknown;
  readonly status: ArtifactRevisionStatus;
  readonly presentation: ArtifactPresentation;
}

/**
 * v2 revisions carry no schema of their own, so the caller supplies the schema
 * key its stage declares for the artifact.
 */
export function selectArtifactDetail(revision: ArtifactRevisionRecord, schema_key: string | null, status: ArtifactRevisionStatus): ArtifactDetail | null {
  const presentation = schema_key === null ? null : outputPresentation(schema_key);
  if (!presentation) return null;
  return {
    run_id: revision.run_id, unit_id: revision.unit_id, artifact: revision.artifact,
    revision_id: revision.id, predecessor_id: revision.predecessor_id, subject: revision.subject,
    body: revision.body, status, presentation,
  };
}
