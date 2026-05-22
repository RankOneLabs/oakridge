import { useQuery } from "@tanstack/react-query";

import type { Task, PermissionProfile } from "../../safir/types";

export function useTasksAndProfiles(): {
  tasks: Task[];
  profiles: PermissionProfile[];
} {
  const tasksQuery = useQuery({
    queryKey: ["safir", "tasks"],
    queryFn: async (): Promise<Task[]> => {
      const res = await fetch("/safir/tasks");
      if (!res.ok) return [];
      const data = (await res.json()) as Task[];
      return data.filter((t) => t.status === "active" || t.status === "backlog");
    },
  });
  const profilesQuery = useQuery({
    queryKey: ["safir", "permission-profiles"],
    queryFn: async (): Promise<PermissionProfile[]> => {
      const res = await fetch("/safir/permission-profiles");
      if (!res.ok) return [];
      return (await res.json()) as PermissionProfile[];
    },
  });
  return {
    tasks: tasksQuery.data ?? [],
    profiles: profilesQuery.data ?? [],
  };
}
