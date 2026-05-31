import { useCallback, useEffect, useState } from "react";

import {
  GraderConfigsResponseSchema,
  GradersResponseSchema,
} from "../lib/types";
import type { GraderConfigDraft, GraderSummary } from "../lib/types";

export function useGraders(): {
  graders: GraderSummary[];
  graderConfigs: GraderConfigDraft[];
  refresh: () => Promise<void>;
} {
  const [graders, setGraders] = useState<GraderSummary[]>([]);
  const [graderConfigs, setGraderConfigs] = useState<GraderConfigDraft[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [gradersResponse, configsResponse] = await Promise.all([
        fetch("/api/graders"),
        fetch("/api/grader-configs"),
      ]);
      if (gradersResponse.ok) {
        const gradersData = GradersResponseSchema.parse(
          await gradersResponse.json(),
        );
        setGraders(gradersData.graders);
      }
      if (configsResponse.ok) {
        const configsData = GraderConfigsResponseSchema.parse(
          await configsResponse.json(),
        );
        setGraderConfigs(configsData.grader_configs);
      }
    } catch {
      // Keep the last good catalogs and retry on the next refresh.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { graders, graderConfigs, refresh };
}
