import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { selectInputRevisionReferences, type RecordedRevisionIdentity, type RelationshipIndex } from "./recorded-relationships";

/** The artifact's recorded publication identity changes only when its immutable history grows. */
export interface StageHistoryRequest {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly revision_count: number;
  readonly latest_revision_id: string | null;
}
export const selectStageHistoryRequests = (unit: OperatorUnitView | null): readonly StageHistoryRequest[] => unit === null ? [] : unit.artifacts
  .filter((artifact) => artifact.run_id === unit.run_id && artifact.unit_id === unit.unit_id)
  .map((artifact) => ({ run_id: unit.run_id, unit_id: unit.unit_id, artifact_key: artifact.artifact_key,
    revision_count: artifact.revision_count, latest_revision_id: artifact.latest_revision?.id ?? null }));

export interface StageHistoryQuery { readonly data: OperatorArtifactDetail | undefined; readonly isError: boolean }
export interface StageHistoryRead { readonly data: readonly OperatorArtifactDetail[] | undefined; readonly isError: boolean }
export function selectStageHistoryRead(unit: OperatorUnitView | null, queries: readonly StageHistoryQuery[]): StageHistoryRead {
  if (unit === null) return { data: undefined, isError: false };
  if (queries.some((query) => query.data === undefined)) return { data: undefined, isError: queries.some((query) => query.isError) };
  return { data: queries.flatMap((query) => query.data === undefined ? [] : [query.data]), isError: false };
}

export interface StageRevisionIndexSource {
  readonly unit: OperatorUnitView;
  readonly units: readonly OperatorUnitView[];
  readonly histories: readonly OperatorArtifactDetail[];
}
/** External links need recorded identities, not preloaded artifact bodies or histories. */
export function selectStageRevisionIndex({ unit, units, histories }: StageRevisionIndexSource): RelationshipIndex {
  const byUnit = new Map(units.filter((candidate) => candidate.run_id === unit.run_id).map((candidate) => [candidate.unit_id, candidate]));
  byUnit.set(unit.unit_id, unit);
  const knownUnits = [...byUnit.values()];
  const snapshots = knownUnits.flatMap((candidate) => candidate.attempts.flatMap((attempt) => attempt.intent
    ? [...selectInputRevisionReferences(attempt.intent.engine_inputs.previous), ...selectInputRevisionReferences(attempt.intent.engine_inputs.subject)] : []));
  const inputs = unit.attempts.flatMap((attempt) => attempt.intent ? selectInputRevisionReferences(attempt.intent.inputs) : []);
  const referenced: RecordedRevisionIdentity[] = [...snapshots, ...inputs].flatMap(({ revision_id, location }) => location === null ? []
    : [{ id: revision_id, run_id: unit.run_id, ...location }]);
  const latest = knownUnits.flatMap((candidate) => candidate.artifacts.flatMap((artifact) => artifact.latest_revision ? [artifact.latest_revision] : []));
  const identities = [...referenced, ...latest, ...histories.flatMap((artifact) => artifact.revisions)];
  const index = new Map<string, RecordedRevisionIdentity>();
  for (const identity of identities) {
    const owner = byUnit.get(identity.unit_id);
    if (identity.run_id !== unit.run_id || !owner?.artifacts.some((artifact) => artifact.artifact_key === identity.artifact_key)) continue;
    index.set(identity.id, identity);
  }
  return { run_id: unit.run_id, units: knownUnits, revisions: [...index.values()] };
}
