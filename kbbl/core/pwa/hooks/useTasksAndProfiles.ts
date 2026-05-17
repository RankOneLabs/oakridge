import { useEffect, useState } from "react";

import type { Task, PermissionProfile } from "../../safir/types";

export function useTasksAndProfiles(): {
  tasks: Task[];
  profiles: PermissionProfile[];
} {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [profiles, setProfiles] = useState<PermissionProfile[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/safir/tasks");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Task[];
        if (cancelled) return;
        setTasks(data.filter((t) => t.status === "active" || t.status === "backlog"));
      } catch {}
    })();
    void (async () => {
      try {
        const res = await fetch("/safir/permission-profiles");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as PermissionProfile[];
        if (cancelled) return;
        setProfiles(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  return { tasks, profiles };
}
