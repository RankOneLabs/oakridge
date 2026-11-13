import { useQueries } from "@tanstack/react-query";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { oakridgeGet, unitPath } from "../client-http";
import { parseArtifactDetail } from "../adapters/parse";
import { unwrap } from "../adapters/core";
import { selectStageHistoryRead, selectStageHistoryRequests } from "../lib/stage-history";

/** Read this unit's histories once per recorded publication change; inventory polling owns freshness. */
export function useStageArtifactHistories(unit: OperatorUnitView | null) {
  const requests = selectStageHistoryRequests(unit);
  const histories = useQueries({ queries: requests.map((request) => ({
    queryKey: ["oakridge", "run", request.run_id, "stage-history", request.unit_id, request.artifact_key, request.revision_count, request.latest_revision_id],
    queryFn: async () => {
      const path = `${unitPath(request.run_id, request.unit_id)}/artifacts/${encodeURIComponent(request.artifact_key)}`;
      return unwrap(path, parseArtifactDetail(await oakridgeGet<unknown>(path)));
    }, staleTime: Infinity, retry: false,
  })) });
  return selectStageHistoryRead(unit, histories);
}
