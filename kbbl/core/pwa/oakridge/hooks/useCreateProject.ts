import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createProject } from "../client-projects";
export function useCreateProject() { const client = useQueryClient(); return useMutation({ mutationFn: createProject, onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "projects"] }); } }); }
