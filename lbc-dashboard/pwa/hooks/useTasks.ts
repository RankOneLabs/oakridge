/**
 * Live task catalog. Loads /api/tasks on mount and then polls every
 * 2s so the Launch form can recover from transient failures without
 * falling back to a static list.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { TasksResponseSchema } from "../lib/types";
import type { TaskSummary } from "../lib/types";

export function useTasks(): {
  tasks: TaskSummary[];
  refresh: () => Promise<void>;
  error: string | null;
} {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestSeq.current;
    try {
      const response = await fetch("/api/tasks");
      if (requestId !== requestSeq.current) return;
      if (!response.ok) {
        const text = await response.text();
        if (requestId !== requestSeq.current) return;
        setError(`Task load failed (${response.status}): ${text}`);
        return;
      }
      const data = TasksResponseSchema.parse(await response.json());
      if (requestId !== requestSeq.current) return;
      setTasks(data.tasks);
      setError(null);
    } catch (cause) {
      if (requestId !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { tasks, refresh, error };
}
