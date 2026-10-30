import { err, ok, type JsonValue, type Result } from "../../domain/primitives";

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
