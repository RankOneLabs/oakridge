/**
 * Live task catalog. Loads /api/tasks once on mount and exposes a
 * manual refresh so the Launch form can recover from transient load
 * failures without falling back to a static list.
 */
import { useCallback, useEffect, useState } from "react";

import { TasksResponseSchema } from "../lib/types";
import type { TaskSummary } from "../lib/types";

export function useTasks(): {
  tasks: TaskSummary[];
  refresh: () => Promise<void>;
  error: string | null;
} {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks");
      if (!response.ok) {
        const text = await response.text();
        setError(`Task load failed (${response.status}): ${text}`);
        return;
      }
      const data = TasksResponseSchema.parse(await response.json());
      setTasks(data.tasks);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { tasks, refresh, error };
}
