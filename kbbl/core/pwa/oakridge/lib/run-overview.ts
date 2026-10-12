import type { OperatorArtifactRevisionRecord, OperatorRunView, OperatorUnitView } from "../operator-contracts";

export interface RunProgress { readonly complete: number; readonly total: number; readonly needs_attention: number }
/** v2 has no output slots: a unit's artifacts are its revisions. */
export interface RunArtifact { readonly unit_id: string; readonly artifact: string; readonly revision: OperatorArtifactRevisionRecord }

export const selectRunProgress = (run: OperatorRunView): RunProgress => ({
  complete: run.units.filter((unit) => unit.is_terminal).length,
  total: run.units.length,
  needs_attention: run.units.filter((unit) => !unit.is_terminal && unit.available_decisions.length > 0).length,
});

export const selectRunUnit = (run: OperatorRunView, unitId: string | null, rootKey: string | null): OperatorRunView["units"][number] | null =>
  run.units.find((unit) => unit.unit_id === unitId)
    ?? run.units.find((unit) => unit.unit_key === rootKey)
    ?? run.units[0] ?? null;

/** The newest revision of each artifact a unit has published. */
export const selectRunArtifacts = (units: readonly OperatorUnitView[]): readonly RunArtifact[] =>
  units.flatMap((unit) => {
    const newest = new Map<string, OperatorArtifactRevisionRecord>();
    for (const revision of unit.revisions) newest.set(revision.artifact, revision);
    return [...newest.entries()].map(([artifact, revision]) => ({ unit_id: unit.unit_id, artifact, revision }));
  });

export const selectLoadedUnits = (values: readonly (OperatorUnitView | undefined)[]): readonly OperatorUnitView[] =>
  values.filter((value): value is OperatorUnitView => value !== undefined);

export const selectUnitDetail = (units: readonly OperatorUnitView[], unitId: string | null): OperatorUnitView | null =>
  unitId === null ? units[0] ?? null : units.find((unit) => unit.unit_id === unitId) ?? null;

export const selectUnitQueryIndex = (run: OperatorRunView, unitId: string | null): number =>
  run.units.findIndex((unit) => unit.unit_id === unitId);

/** A blocked unit is the v2 shape of what v1 called a waiting scope. */
export const selectWaitingUnits = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => unit.status.kind === "blocked");

export const selectCompletedUnitDetails = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => unit.status.kind === "done");

export const selectFinalIntegrationUnit = (units: readonly OperatorUnitView[]): OperatorUnitView | null =>
  units.find((unit) => unit.unit_key === "final_integration") ?? null;

export const selectArtifactInUnits = (units: readonly OperatorUnitView[], revisionId: string): RunArtifact | null =>
  selectRunArtifacts(units).find((artifact) => artifact.revision.id === revisionId) ?? null;

export const selectUnitStatus = (unit: OperatorRunView["units"][number]): "complete" | "attention" | "running" =>
  unit.is_terminal ? "complete" : unit.available_decisions.length > 0 ? "attention" : "running";
