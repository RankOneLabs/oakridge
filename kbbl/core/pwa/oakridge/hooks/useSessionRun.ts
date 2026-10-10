import { useQuery } from "@tanstack/react-query";
import { fetchOperatorSessionLocation } from "../client";
import { queryKeys } from "../queryKeys";

export const useSessionRun = (sessionId: string) => useQuery({
  queryKey: queryKeys.sessionLocation(sessionId), queryFn: () => fetchOperatorSessionLocation(sessionId),
});
