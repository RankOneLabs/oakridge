import { useQuery } from "@tanstack/react-query";
import { readUnits } from "../client-units";
import { selectHandoffUnitId, selectHandoffRevisionId } from "../lib/handoff-provenance";
/** The unit's recorded decisions, adjudications and validator rejections alike, exclusively from the authority's decision projection. */
export function useAssessmentHistory(runId: string, revisionId: string) {
  return useQuery({ queryKey: ["oakridge", "run", runId, "assessment-history", revisionId], queryFn: async () => {
    const unitId = selectHandoffUnitId(revisionId);
    const units = await readUnits(runId);
    const unit = units.find(unit => unit.unit_id === unitId || unit.artifacts.some(artifact => artifact.latest_revision?.id === selectHandoffRevisionId(revisionId)));
    return unit?.recorded_decisions ?? [];
  }, enabled: Boolean(runId && revisionId), refetchInterval: 10_000 });
}
