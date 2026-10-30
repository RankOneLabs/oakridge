import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import type { EvidenceKind } from "../../grading/evidence";

/** Declared sensitivity of fields in development artifact bodies. Unknown fields fail closed. */
export type ProjectionArtifactKind = "analysis" | "plan" | "brief" | "assessment";
export type ProjectionFieldKind = "public" | "internal" | "restricted" | "repository_content" | "unclassified_content";
export interface ClassificationError { readonly operation: "classify_projection_body"; readonly entity_id: string; readonly detail: string }
export interface ClassifiedBody {
  readonly public_fields: Readonly<Record<string, JsonValue>>;
  readonly field_kinds: Readonly<Record<string, ProjectionFieldKind>>;
}

// These top-level fields mirror workflow-config/development.yaml's body schemas.
const ANALYSIS_BODY_FIELDS: Readonly<Record<string, ProjectionFieldKind>> = {
  summary: "internal", source_spec_refs: "public", findings: "internal", requirements: "internal",
  risks: "internal", proposed_spec_updates: "internal",
};
const PLAN_BODY_FIELDS: Readonly<Record<string, ProjectionFieldKind>> = {
  summary: "internal", cohorts: "internal", dependency_order: "public", scope: "internal",
  acceptance_criteria: "internal", risks: "internal",
};
const BRIEF_BODY_FIELDS: Readonly<Record<string, ProjectionFieldKind>> = {
  cohort_id: "public", repository_key: "public", title: "internal", depends_on: "public",
  goal: "internal", files_in_scope: "restricted", decisions_made: "internal",
  approaches_rejected: "internal", acceptance_criteria: "internal", next_action: "internal",
};
const ASSESSMENT_BODY_FIELDS: Readonly<Record<string, ProjectionFieldKind>> = {
  head_sha: "public", verdict: "public", findings: "internal", test_evidence: "restricted",
  recommended_next_actions: "internal",
};

const BODY_FIELDS: Readonly<Record<ProjectionArtifactKind, Readonly<Record<string, ProjectionFieldKind>>>> = {
  analysis: ANALYSIS_BODY_FIELDS, plan: PLAN_BODY_FIELDS, brief: BRIEF_BODY_FIELDS,
  assessment: ASSESSMENT_BODY_FIELDS,
};

export function classifyProjectionField(artifactKind: ProjectionArtifactKind, field: string): Result<ProjectionFieldKind, ClassificationError> {
  const declaredFields = BODY_FIELDS[artifactKind];
  return ok(Object.hasOwn(declaredFields, field) ? declaredFields[field] : "unclassified_content");
}

const CLASSIFIED_ARTIFACT_KINDS: readonly ProjectionArtifactKind[] = ["analysis", "plan", "brief", "assessment"];

/** Only the four development artifact kinds declare field sensitivity. */
function projectionArtifactKind(artifact_kind: string): ProjectionArtifactKind | null {
  return CLASSIFIED_ARTIFACT_KINDS.find((candidate) => candidate === artifact_kind) ?? null;
}

/** A captured item inherits the declared sensitivity of the top-level body field it was selected from. */
function topLevelField(path: string): string | null {
  const field = path.split("/")[1];
  return field ? field : null;
}

/** Only public and classified repository content may leave the service. Every other declared
 * kind, and any undeclared artifact kind or field, fails closed to internal. */
export function evidenceKindForCapturedPath(artifact_kind: string, path: string): Result<EvidenceKind, ClassificationError> {
  const kind = projectionArtifactKind(artifact_kind);
  const field = topLevelField(path);
  if (!kind || !field) return ok("internal");
  const classified = classifyProjectionField(kind, field);
  if (!classified.ok) return classified;
  return ok(classified.value === "public" ? "public"
    : classified.value === "repository_content" ? "repository_content" : "internal");
}

/** Only fields explicitly declared public can enter a whole-body projection. */
export function projectClassifiedBody(artifactKind: ProjectionArtifactKind, body: JsonValue): Result<ClassifiedBody, ClassificationError> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return err({ operation: "classify_projection_body", entity_id: artifactKind, detail: "artifact body must be an object" });
  const public_fields: Record<string, JsonValue> = Object.create(null);
  const field_kinds: Record<string, ProjectionFieldKind> = Object.create(null);
  for (const [field, value] of Object.entries(body)) {
    const classified = classifyProjectionField(artifactKind, field);
    if (!classified.ok) return classified;
    field_kinds[field] = classified.value;
    if (classified.value === "public") public_fields[field] = value;
  }
  return ok({ public_fields, field_kinds });
}
