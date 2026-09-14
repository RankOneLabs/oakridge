import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateProject } from "../client";
import type { Project } from "../types";

interface UpdateProjectInput {
  readonly id: string;
  readonly name: string;
  readonly repo_dir: string;
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation<Project, Error, UpdateProjectInput>({
    mutationFn: ({ id, name, repo_dir }) => updateProject(id, { name, repo_dir }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "projects"] }); },
  });
}
