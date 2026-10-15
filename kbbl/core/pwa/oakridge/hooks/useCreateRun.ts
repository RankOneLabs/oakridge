import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createRun } from "../client";
import type { CreateRunRequest } from "../types";
export interface CreateRunCommand { readonly request: CreateRunRequest; readonly idempotency_key: string }
export function useCreateRun() { const client = useQueryClient(); return useMutation({ mutationFn: (command: CreateRunCommand) => createRun(command.request, command.idempotency_key), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "runs"] }); } }); }
