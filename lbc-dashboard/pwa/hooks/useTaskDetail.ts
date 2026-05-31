import { useEffect, useState } from "react";

import { TaskDetailSchema } from "../lib/types";
import type { TaskDetail } from "../lib/types";

export function useTaskDetail(taskName: string | null): TaskDetail | null {
  const [detail, setDetail] = useState<TaskDetail | null>(null);

  useEffect(() => {
    if (taskName === null || taskName.trim() === "") {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(taskName)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setDetail(null);
          return;
        }
        setDetail(TaskDetailSchema.parse(await response.json()));
      } catch {
        if (!controller.signal.aborted) {
          setDetail(null);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [taskName]);

  return detail;
}
