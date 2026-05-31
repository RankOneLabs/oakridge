import { useCallback, useEffect, useRef, useState } from "react";

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
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestSeq.current;
    try {
      const [gradersResult, configsResult] = await Promise.allSettled([
        fetch("/api/graders"),
        fetch("/api/grader-configs"),
      ]);
      if (gradersResult.status === "fulfilled" && gradersResult.value.ok) {
        const gradersData = GradersResponseSchema.parse(
          await gradersResult.value.json(),
        );
        if (requestId === requestSeq.current) {
          setGraders(gradersData.graders);
        }
      }
      if (configsResult.status === "fulfilled" && configsResult.value.ok) {
        const configsData = GraderConfigsResponseSchema.parse(
          await configsResult.value.json(),
        );
        if (requestId === requestSeq.current) {
          setGraderConfigs(configsData.grader_configs);
        }
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
