import type { OperatorJsonValue } from "../../core/pwa/oakridge/operator-contracts/domain/primitives";
import { CURRENT_ASSESSMENT } from "../../core/pwa/oakridge/__fixtures__/current-assessments";
import analysis from "../../core/pwa/oakridge/__fixtures__/current-analysis.json";
import spec from "../../core/pwa/oakridge/__fixtures__/current-spec.json";
import plan from "../../core/pwa/oakridge/__fixtures__/current-plan.json";
import brief from "../../core/pwa/oakridge/__fixtures__/current-brief.json";
import { canonicalSpecUnit } from "../../core/pwa/oakridge/__fixtures__/read-models";
import { OPERATOR_CURRENT_ARTIFACT_VERSIONS } from "../../core/pwa/oakridge/operator-contracts/artifact-versions";
import type { OperatorUnitView } from "../../core/pwa/oakridge/operator-contracts/projections/unit-view";
import type { OperatorArtifactDetail } from "../../core/pwa/oakridge/operator-contracts/projections/artifact-view";
export type CurrentArtifactKind = "analysis" | "spec" | "plan" | "brief" | "assessment";
export interface CurrentArtifactFixture { readonly unit: OperatorUnitView; readonly detail: OperatorArtifactDetail }
const bodies = { analysis, spec, plan, brief, assessment: CURRENT_ASSESSMENT };
export function currentArtifactFixture(kind: CurrentArtifactKind): CurrentArtifactFixture {
  const base = canonicalSpecUnit();
  const schema = `${kind}_body` as keyof typeof OPERATOR_CURRENT_ARTIFACT_VERSIONS;
  const stage = kind === "spec" ? "analysis" : kind === "plan" ? "planning" : kind === "assessment" ? "cohort" : kind;
  const unit_id = `run/${stage}`;
  const revision = { id: `${unit_id}:${kind}:1`, run_id: "run", unit_id, artifact_key: kind, number: 1,
    artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS[schema].version, attempt_id: null, body: JSON.parse(JSON.stringify(bodies[kind])) as OperatorJsonValue,
    predecessor_id: null, subject_id: null, created_at: "2026-11-17T12:00:00Z" };
  return {
    unit: { ...base, unit_id, stage, input: { spec, assignment: { cohort: plan.cohorts[0], requirements: spec.requirements } },
      artifacts: [{ run_id: "run", unit_id, artifact_key: kind, schema, is_reviewable: false, is_editable: false, revision_count: 1, latest_revision: revision }],
      recorded_decisions: [], decisions: [] },
    detail: { run_id: "run", unit_id, artifact_key: kind, schema, is_reviewable: false, is_editable: false, status: "draft",
      revisions: [revision], decisions: [], original_spec: "Original operator input" },
  };
}
