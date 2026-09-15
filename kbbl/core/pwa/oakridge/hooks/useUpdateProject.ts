import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateProject } from "../client";
import type { Result } from "../../lib/result";
import type { Project, ProjectUpdateCommand, ProjectUpdateError } from "../types";

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation<Result<Project, ProjectUpdateError>, never, ProjectUpdateCommand>({
    mutationFn: updateProject,
    onSuccess: (result) => {
      if (result.ok) void client.invalidateQueries({ queryKey: ["oakridge", "projects"] });
    },
  });
}
