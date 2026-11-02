import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import { useArchiveRun } from "./useArchiveRun";
import { useResumeGate } from "./useResumeGate";
import { useRetryStuck } from "./useRetryStuck";

const backend = vi.hoisted(() => ({ version: 0 }));
vi.mock("../client", () => ({
  archiveRun: vi.fn(async () => { backend.version += 1; return { is_archived: true }; }),
  resumeGate: vi.fn(async () => { backend.version += 1; return { gate_id: "gate", resumed: true }; }),
  retryRunUnit: vi.fn(async () => { backend.version += 1; return { kind: "committed" }; }),
}));

beforeEach(() => { backend.version = 0; });

function queryWrapper(client: QueryClient) {
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function useObservedVersion(queryKey: readonly string[]) {
  return useQuery({ queryKey: [...queryKey], queryFn: async () => backend.version, staleTime: Infinity });
}

test("a gate decision refreshes the run detail, run list, gates, and sessions", async () => {
  const client = new QueryClient();
  const { result } = renderHook(() => ({
    run: useObservedVersion(["oakridge", "run", "run-1"]),
    runs: useObservedVersion(["oakridge", "runs"]),
    gates: useObservedVersion(["oakridge", "run", "run-1", "gates"]),
    sessions: useObservedVersion(["oakridge", "run", "run-1", "sessions"]),
    action: useResumeGate("gate", "run-1"),
  }), { wrapper: queryWrapper(client) });
  await waitFor(() => expect([result.current.run.data, result.current.runs.data, result.current.gates.data, result.current.sessions.data]).toEqual([0, 0, 0, 0]));
  await act(async () => { await result.current.action.mutateAsync({ idempotency_key: "decision-1", artifact_revision_id: "revision",
    action: "approve", feedback: "" }); });
  await waitFor(() => expect([result.current.run.data, result.current.runs.data, result.current.gates.data, result.current.sessions.data]).toEqual([1, 1, 1, 1]));
  client.clear();
});

test("retry refreshes the run list, sessions, and inbox", async () => {
  const client = new QueryClient();
  const { result } = renderHook(() => ({
    runs: useObservedVersion(["oakridge", "runs"]),
    sessions: useObservedVersion(["oakridge", "run", "run-1", "sessions"]),
    inbox: useObservedVersion(["oakridge", "review-inbox"]),
    action: useRetryStuck("run-1"),
  }), { wrapper: queryWrapper(client) });
  await waitFor(() => expect([result.current.runs.data, result.current.sessions.data, result.current.inbox.data]).toEqual([0, 0, 0]));
  await act(async () => { await result.current.action.mutateAsync({ stageInstanceId: "stage", unitId: "unit" }); });
  await waitFor(() => expect([result.current.runs.data, result.current.sessions.data, result.current.inbox.data]).toEqual([1, 1, 1]));
  client.clear();
});

test("archive refreshes the run list, gates, and inbox", async () => {
  const client = new QueryClient();
  const { result } = renderHook(() => ({
    runs: useObservedVersion(["oakridge", "runs"]),
    gates: useObservedVersion(["oakridge", "gates"]),
    inbox: useObservedVersion(["oakridge", "review-inbox"]),
    action: useArchiveRun("run-1"),
  }), { wrapper: queryWrapper(client) });
  await waitFor(() => expect([result.current.runs.data, result.current.gates.data, result.current.inbox.data]).toEqual([0, 0, 0]));
  await act(async () => { await result.current.action.mutateAsync(); });
  await waitFor(() => expect([result.current.runs.data, result.current.gates.data, result.current.inbox.data]).toEqual([1, 1, 1]));
  client.clear();
});
