import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchOakridgeConfig,
  fetchProjects,
  createProject,
  fetchWorkflowDefs,
  createRun,
  cancelRun,
  retryStuckStage,
  fetchRuns,
  fetchRun,
  fetchRunGates,
  fetchGates,
  fetchArtifact,
  fetchArtifactTypes,
  resumeGate,
  fetchThreads,
  postThread,
  postMessage,
  pingThread,
  resolveThread,
  fetchReviewItems,
  postReviewItem,
  patchReviewItem,
  postAtomEdit,
} from "./client";
import type {
  CreateRunRequest,
  GateResumeRequest,
  PostThreadRequest,
  PostMessageRequest,
  PostAtomEditRequest,
  PostReviewItemRequest,
  PatchReviewItemRequest,
} from "./types";

const POLL_MS = 10_000;

export function useOakridgeConfig() {
  return useQuery({
    queryKey: ["oakridge", "config"],
    queryFn: fetchOakridgeConfig,
    staleTime: 30_000,
  });
}

export function useRuns() {
  return useQuery({
    queryKey: ["oakridge", "runs"],
    queryFn: fetchRuns,
    refetchInterval: POLL_MS,
  });
}

export function useRun(id: string) {
  return useQuery({
    queryKey: ["oakridge", "run", id],
    queryFn: () => fetchRun(id),
    refetchInterval: POLL_MS,
  });
}

export function useRunGates(runId: string) {
  return useQuery({
    queryKey: ["oakridge", "run", runId, "gates"],
    queryFn: () => fetchRunGates(runId),
    refetchInterval: POLL_MS,
  });
}

export function useGates() {
  return useQuery({
    queryKey: ["oakridge", "gates"],
    queryFn: fetchGates,
    refetchInterval: POLL_MS,
  });
}

export function useArtifact(id: string) {
  return useQuery({
    queryKey: ["oakridge", "artifact", id],
    queryFn: () => fetchArtifact(id),
  });
}

export function useArtifactTypes() {
  return useQuery({
    queryKey: ["oakridge", "artifact_types"],
    queryFn: fetchArtifactTypes,
    staleTime: 60_000,
  });
}

export function useResumeGate(gateId: string, runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: GateResumeRequest) => resumeGate(gateId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "gates"] });
      if (runId) {
        void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
        void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
      }
    },
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["oakridge", "projects"],
    queryFn: fetchProjects,
  });
}

export function useWorkflowDefs() {
  return useQuery({
    queryKey: ["oakridge", "workflow_defs"],
    queryFn: fetchWorkflowDefs,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "projects"] });
    },
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRunRequest) => createRun(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "runs"] });
    },
  });
}

export function useCancelRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cancelRun(runId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void qc.invalidateQueries({ queryKey: ["oakridge", "runs"] });
    },
  });
}

export function useRetryStuck(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (stageInstanceId: string) => retryStuckStage(stageInstanceId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    },
  });
}

// ── Collab hooks ──────────────────────────────────────────────────────────────

export function useThreads(artifactId: string, enabled = true) {
  return useQuery({
    queryKey: ["oakridge", "artifact", artifactId, "threads"],
    queryFn: () => fetchThreads(artifactId),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function usePostThread(artifactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PostThreadRequest) => postThread(artifactId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] });
    },
  });
}

export function usePostMessage(artifactId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PostMessageRequest) => postMessage(threadId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] });
    },
  });
}

export function usePingThread(_artifactId: string) {
  return useMutation({
    mutationFn: (threadId: string) => pingThread(threadId),
  });
}

export function useResolveThread(artifactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => resolveThread(threadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] });
    },
  });
}

export function useReviewItems(artifactId: string, enabled = true) {
  return useQuery({
    queryKey: ["oakridge", "artifact", artifactId, "review_items"],
    queryFn: () => fetchReviewItems(artifactId),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function usePostReviewItem(artifactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PostReviewItemRequest) => postReviewItem(artifactId, req),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["oakridge", "artifact", artifactId, "review_items"],
      });
    },
  });
}

export function usePatchReviewItem(artifactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: PatchReviewItemRequest }) =>
      patchReviewItem(id, req),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["oakridge", "artifact", artifactId, "review_items"],
      });
    },
  });
}

export function useAtomEdit(artifactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PostAtomEditRequest) => postAtomEdit(artifactId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId] });
    },
  });
}
