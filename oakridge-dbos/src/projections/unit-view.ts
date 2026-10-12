import type { ReviewDecision, TypeExpression, UnitStatus, Workflow } from "../core-client/core-types";
import type { ArtifactRevisionRecord, ReviewItemRecord, RunId, UnitId } from "../storage/schema-records";

/** Where a projection was read, so an operator write can detect a changed unit. */
export interface ProjectionCursor { readonly unit_version: number; readonly event_id: string | null }

/**
 * One decision a unit's stage offers an operator, named by review and decision
 * key. `fields` and `payload` are what the operator form collects; `inputs` is
 * the review's own evidence, which the operator reads rather than retypes.
 */
export interface AvailableDecision {
  readonly review: string;
  readonly decision: string;
  /** The artifact the review is `of`, so a caller can resolve the target revision. */
  readonly artifact: string;
  readonly label: string;
  readonly effect: ReviewDecision["effect"];
  readonly fields: { readonly [field: string]: string };
  readonly payload: TypeExpression | null;
  readonly inputs: { readonly [input: string]: string };
}

export interface UnitView {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  /** The unit's declaration key, which names its stage in the workflow. */
  readonly unit_key: string;
  readonly stage: string | null;
  readonly status: UnitStatus;
  readonly version: number;
  readonly cursor: ProjectionCursor;
  readonly revisions: readonly ArtifactRevisionRecord[];
  /** artifact key -> its declared schema name, which selects the artifact's viewer. */
  readonly artifact_schemas: { readonly [artifact: string]: string };
  readonly open_reviews: readonly ReviewItemRecord[];
  readonly decisions: readonly AvailableDecision[];
}

export const isTerminalStatus = (status: UnitStatus): boolean => status.kind === "done" || status.kind === "cancelled";

/**
 * Only a review declared `by: operator` reaches the operator surface; a
 * worker's own review is internal to evaluation.
 */
export function selectAvailableDecisions(workflow: Workflow, stage_key: string | null): readonly AvailableDecision[] {
  if (stage_key === null) return [];
  const stage = workflow.stages[stage_key];
  if (!stage) return [];
  const decisions: AvailableDecision[] = [];
  for (const [review, declaration] of Object.entries(stage.reviews ?? {})) {
    if (declaration.by !== "operator") continue;
    for (const [decision, option] of Object.entries(declaration.decisions))
      decisions.push({ review, decision, artifact: declaration.of, label: option.label, effect: option.effect,
        fields: option.fields ?? {}, payload: option.payload ?? null, inputs: declaration.inputs });
  }
  return decisions;
}

/** The schema a stage declares for one of its artifacts, when it names one directly. */
export function artifactSchemaKey(workflow: Workflow, stage_key: string | null, artifact: string): string | null {
  if (stage_key === null) return null;
  const schema = workflow.stages[stage_key]?.artifacts[artifact]?.schema;
  return typeof schema === "string" ? schema : null;
}

/**
 * v1 carried the schema on the body, so a viewer was chosen from the value
 * itself. v2 bodies are plain, so the stage's artifact declaration names the
 * schema and the operator surface keys its viewers off this map instead.
 */
export function selectArtifactSchemas(workflow: Workflow, stage_key: string | null): { readonly [artifact: string]: string } {
  if (stage_key === null) return {};
  const artifacts = workflow.stages[stage_key]?.artifacts ?? {};
  const named: { [artifact: string]: string } = {};
  for (const [artifact, declaration] of Object.entries(artifacts))
    if (typeof declaration.schema === "string") named[artifact] = declaration.schema;
  return named;
}
