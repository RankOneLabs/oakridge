import { useQuery } from "@tanstack/react-query";
import { fetchProjects } from "../client-projects";
export function useProjects() { return useQuery({ queryKey: ["oakridge", "projects"], queryFn: fetchProjects }); }
