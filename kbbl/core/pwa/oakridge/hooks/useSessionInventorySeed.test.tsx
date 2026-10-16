import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { useStore } from "../../state/store";
import type { SessionSnapshot } from "../../types";
import type { RunDetail, RunSessionAttempt } from "../types";
import { selectPurgedRunSessionIds } from "../lib/run-sessions";
import { useRunSessions } from "./useRunSessions";

const existing: SessionSnapshot = {
  sid: "existing", name: "Existing", agentProfile: "codex", status: "idle", source: "acp",
  lastActivityTs: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  artifactId: null, projectWorkdir: "/repo", worktreePath: "/repo", worktreeBranch: null,
  worktreeBaseRef: null, requestedModel: null, requestedEffort: null, endReason: null,
  fencedBy: null, pendingPermissionCount: 0, workflow: null,
};
const run: RunDetail = { id: "run-reload", title: null, repository_keys: [], workflow_name: "development",
  status: "parked", stages: [], parked_count: 1, updated_at: "2026-09-01T00:00:00Z", is_stuck: false };
const attempts: RunSessionAttempt[] = ["deleted", "existing"].map((session_id) => ({
  work_order_id: session_id, session_id, stage_instance_id: "stage", stage_key: "builder", unit_id: "cohort",
  reason: "initial", work_order_state: "completed", created_at: "2026-09-01T00:00:00Z",
  completed_at: null, executor_health_kind: null, cleanup_state: "not_needed",
}));

afterEach(() => { vi.restoreAllMocks(); useStore.setState(useStore.getInitialState()); });

test("a fresh run workspace hides sessions absent from the successful server inventory", async () => {
  useStore.setState(useStore.getInitialState());
  useStore.getState().applySnapshot([existing]);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ sessions: [existing] }),
    { headers: { "Content-Type": "application/json" } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["oakridge", "run", run.id, "sessions"], attempts);
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  const hook = renderHook(() => useRunSessions(run.id), { wrapper });
  await waitFor(() => expect(useStore.getState().hasSessionSeed).toBe(true));
  const purged = selectPurgedRunSessionIds({ run, sessions: { kind: "loaded", attempts }, inventory: useStore.getState() });
  expect([...purged]).toEqual(["deleted"]);
  expect(fetchMock).toHaveBeenCalledWith("/sessions");
  hook.unmount();
});
