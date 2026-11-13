import { useQuery } from "@tanstack/react-query";
import { oakridgeGet, runPath } from "../client-http";
import { parseUnitViews } from "../adapters/parse";
import { unwrap } from "../adapters/core";
/** Full inputs for the stage overview; the legacy run adapter deliberately requests a smaller slice. */
export function useOperatorUnits(run_id: string) {
  return useQuery({ queryKey: ["oakridge", "run", run_id, "operator-units"], queryFn: async () => {
    const path = `${runPath(run_id)}/units`;
    return unwrap(path, parseUnitViews(await oakridgeGet<unknown>(path)));
  }, refetchInterval: 10_000 });
}
