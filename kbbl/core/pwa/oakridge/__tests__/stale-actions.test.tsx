import { expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRetryStuck } from "../hooks/useRetryStuck";
import { useAbandonCohort } from "../hooks/useAbandonCohort";

const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("../client", () => ({
  fetchRun: vi.fn(async () => ({ stages: [{ stage_instance_id: "stage", units: [{ unit_id: "unit", cohort_id: "cohort", version: 9, workers: [] }] }] })),
  submitCohortRequest: submit,
}));
function wrapper({ children }: { readonly children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}
it("stale retry and abandon intents conflict before any request is submitted", async () => {
  submit.mockClear();
  const retry = renderHook(() => useRetryStuck("run"), { wrapper });
  const abandon = renderHook(() => useAbandonCohort("run"), { wrapper });
  await act(async () => {
    await expect(retry.result.current.mutateAsync({ stageInstanceId: "stage", unitId: "unit", observedVersion: 7 })).rejects.toThrow("changed");
    await expect(abandon.result.current.mutateAsync({ cohortId: "cohort", detail: "reason", observedVersion: 7 })).rejects.toThrow("changed");
  });
  expect(submit).not.toHaveBeenCalled();
});
