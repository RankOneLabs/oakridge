import { useCallback, useEffect, useState } from "react";

import { TasksResponseSchema } from "../lib/types";
import type { TaskSummary } from "../lib/types";

export function useTasks(): {
  tasks: TaskSummary[];
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks");
      if (!response.ok) return;
      const data = TasksResponseSchema.parse(await response.json());
      setTasks(data.tasks);
    } catch {
      // Keep the last good catalog and retry on the next refresh.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { tasks, refresh };
}
