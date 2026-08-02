import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRun } from "../client";
import type { CreateRunRequest } from "../types";
export function useCreateRun() { const client = useQueryClient(); return useMutation({ mutationFn: (request: CreateRunRequest) => createRun(request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "runs"] }); } }); }
