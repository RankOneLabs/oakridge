import { useMutation, useQueryClient } from "@tanstack/react-query";
import { resumeGate } from "../client";
import type { GateResumeRequest } from "../types";
export function useResumeGate(gateId: string, runId: string | null) { const client = useQueryClient(); return useMutation({ mutationFn: (request: GateResumeRequest) => resumeGate(gateId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "gates"] }); void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] }); if (runId) { void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] }); } } }); }
