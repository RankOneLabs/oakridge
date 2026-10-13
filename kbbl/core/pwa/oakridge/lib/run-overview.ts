import type { OperatorArtifactRevisionView, OperatorArtifactView, OperatorRunUnitSummary, OperatorRunView, OperatorUnitStatus, OperatorUnitView } from "../operator-contracts";

export interface RunProgress { readonly complete: number; readonly total: number; readonly needs_attention: number }
export interface RunArtifact { readonly unit_id: string; readonly artifact: OperatorArtifactView; readonly revision: OperatorArtifactRevisionView }

export const selectRunProgress = (run: OperatorRunView): RunProgress => ({
  complete: run.units.filter((unit) => unit.status.kind === "done").length,
  total: run.units.length,
  needs_attention: run.units.filter((unit) => !unit.is_terminal && unit.asks.length > 0).length,
});

export const selectRunUnit = (run: OperatorRunView, unitId: string | null, rootKey: string | null): OperatorRunUnitSummary | null =>
  run.units.find((unit) => unit.unit_id === unitId)
    ?? run.units.find((unit) => unit.unit_key === rootKey)
    ?? run.units[0] ?? null;

export const selectRunArtifacts = (units: readonly OperatorUnitView[]): readonly RunArtifact[] =>
  units.flatMap((unit) => unit.artifacts.flatMap((artifact) => artifact.latest_revision
    ? [{ unit_id: unit.unit_id, artifact, revision: artifact.latest_revision }] : []));

export const selectLoadedUnits = (values: readonly (OperatorUnitView | undefined)[]): readonly OperatorUnitView[] =>
  values.filter((value): value is OperatorUnitView => value !== undefined);

export const selectUnitDetail = (units: readonly OperatorUnitView[], unitId: string | null): OperatorUnitView | null =>
  unitId === null ? units[0] ?? null : units.find((unit) => unit.unit_id === unitId) ?? null;

export const selectUnitQueryIndex = (run: OperatorRunView, unitId: string | null): number =>
  run.units.findIndex((unit) => unit.unit_id === unitId);

export const selectWaitingUnits = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => unit.attention?.kind === "waiting");

export const selectCompletedUnitDetails = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => unit.outcome !== null);

export const selectFinalIntegrationUnit = (units: readonly OperatorUnitView[]): OperatorUnitView | null =>
  units.find((unit) => unit.unit_key === "final_integration") ?? null;

export const selectArtifactInUnits = (units: readonly OperatorUnitView[], revisionId: string): RunArtifact | null =>
  selectRunArtifacts(units).find((artifact) => artifact.revision.id === revisionId) ?? null;

/** A unit's badge: done is complete and cancelled is cancelled, never complete; otherwise asks are attention. */
export function selectUnitBadgeStatus(status: OperatorUnitStatus, has_asks: boolean): "complete" | "cancelled" | "attention" | "running" {
  if (status.kind === "done") return "complete";
  if (status.kind === "cancelled") return "cancelled";
  return has_asks ? "attention" : "running";
}

export const selectUnitStatus = (unit: OperatorRunUnitSummary): "complete" | "cancelled" | "attention" | "running" =>
  selectUnitBadgeStatus(unit.status, unit.asks.length > 0);

/** A unit's status in words. */
export function selectUnitStatusLabel(status: OperatorUnitStatus): string {
  switch (status.kind) {
    case "not_started": return "Not started";
    case "active": return "Active";
    case "blocked": return status.reason.kind === "capacity" ? `Waiting for capacity in ${status.reason.pool}` : "Waiting on other units";
    case "done": return "Done";
    case "cancelled": return "Cancelled";
  }
}
