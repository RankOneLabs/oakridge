import { useQuery } from "@tanstack/react-query";

import type { Result } from "../lib/result";
import { responseError } from "../lib/http";
import type { Task, PermissionProfile } from "../../safir/types";

type TasksResult = Result<Task[], Error>;
type ProfilesResult = Result<PermissionProfile[], Error>;

export function useTasksAndProfiles(): {
  tasks: TasksResult | null;
  profiles: ProfilesResult | null;
} {
  const tasksQuery = useQuery({
    queryKey: ["safir", "tasks"],
    queryFn: async (): Promise<TasksResult> => {
      const res = await fetch("/safir/tasks");
      if (!res.ok) return { ok: false, error: await responseError(res, "tasks") };
      const data = (await res.json()) as Task[];
      return {
        ok: true,
        value: data.filter((t) => t.status === "active" || t.status === "backlog"),
      };
    },
  });
  const profilesQuery = useQuery({
    queryKey: ["safir", "permission-profiles"],
    queryFn: async (): Promise<ProfilesResult> => {
      const res = await fetch("/safir/permission-profiles");
      if (!res.ok) return { ok: false, error: await responseError(res, "permission profiles") };
      return { ok: true, value: (await res.json()) as PermissionProfile[] };
    },
  });
  return {
    tasks: tasksQuery.data ?? null,
    profiles: profilesQuery.data ?? null,
  };
}
