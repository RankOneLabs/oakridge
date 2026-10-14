import type { OperatorArtifactRevisionView, OperatorArtifactView, OperatorRunUnitSummary, OperatorRunView, OperatorUnitStatus, OperatorUnitView } from "../operator-contracts";
import { selectUnitAsks } from "./decision-queue";
import { selectRootUnitId } from "./operator-selectors";

export interface RunProgress { readonly complete: number; readonly total: number }
export interface RunArtifact { readonly unit_id: string; readonly artifact: OperatorArtifactView; readonly revision: OperatorArtifactRevisionView }

export const selectRunProgress = (run: OperatorRunView): RunProgress => ({
  complete: run.units.filter((unit) => unit.status.kind === "done").length,
  total: run.units.length,
});

/**
 * The unit a run workspace shows: the routed unit, else the root named by the
 * pinned definition. Null until the definition names a root the run holds —
 * never a guess at whichever unit the server listed first.
 */
export const selectRunUnit = (run: OperatorRunView, unitId: string | null, rootKey: string | null): OperatorRunUnitSummary | null => {
  const routed = run.units.find((unit) => unit.unit_id === unitId);
  if (routed) return routed;
  if (rootKey === null) return null;
  const rootId = selectRootUnitId({ units: run.units, root_key: rootKey });
  return run.units.find((unit) => unit.unit_id === rootId) ?? null;
};

export const selectRunArtifacts = (units: readonly OperatorUnitView[]): readonly RunArtifact[] =>
  units.flatMap((unit) => unit.artifacts.flatMap((artifact) => artifact.latest_revision
    ? [{ unit_id: unit.unit_id, artifact, revision: artifact.latest_revision }] : []));

export const selectUnitDetail = (units: readonly OperatorUnitView[], unitId: string | null): OperatorUnitView | null =>
  unitId === null ? null : units.find((unit) => unit.unit_id === unitId) ?? null;

export const selectWaitingUnits = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => unit.attention?.kind === "waiting");

export const selectCompletedUnitDetails = (units: readonly OperatorUnitView[]): readonly OperatorUnitView[] =>
  units.filter((unit) => unit.outcome !== null);

export const selectArtifactInUnits = (units: readonly OperatorUnitView[], revisionId: string): RunArtifact | null =>
  selectRunArtifacts(units).find((artifact) => artifact.revision.id === revisionId) ?? null;

export type UnitBadgeStatus = "complete" | "cancelled" | "attention" | "running";

/** A unit's badge: done is complete and cancelled is cancelled, never complete; otherwise asks are attention. */
function selectUnitBadgeStatus(status: OperatorUnitStatus, has_asks: boolean): UnitBadgeStatus {
  if (status.kind === "done") return "complete";
  if (status.kind === "cancelled") return "cancelled";
  return has_asks ? "attention" : "running";
}

export const selectUnitStatus = (unit: OperatorRunUnitSummary): UnitBadgeStatus =>
  selectUnitBadgeStatus(unit.status, unit.asks.length > 0);

/** A loaded unit's badge, from its asks: the run's cancel on a live root is not attention. */
export const selectUnitDetailStatus = (unit: OperatorUnitView): UnitBadgeStatus =>
  selectUnitBadgeStatus(unit.status, selectUnitAsks(unit).length > 0);

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
