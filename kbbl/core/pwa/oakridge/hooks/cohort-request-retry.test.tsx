import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { fetchRun, submitCohortRequest } from "../client";
import type { RunDetail } from "../types";
import { useAbandonCohort } from "./useAbandonCohort";
import { useRetryStuck } from "./useRetryStuck";

vi.mock("../client", async (importOriginal) => ({ ...await importOriginal<typeof import("../client")>(), fetchRun: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const runAtVersion = (version: number): RunDetail => ({ stages: [{ stage_instance_id: "stage", units: [{
  cohort_id: "cohort", unit_id: "unit", version, workers: [{ worker: "provision", record: { state: "interrupted" } }],
}] }] } as unknown as RunDetail);

for (const action of ["abandon", "retry"] as const) {
  for (const failure of ["conflict", "transport", "server"] as const) {
    it(`${action} recovers from ${failure} with the appropriate request identity and version`, async () => {
      vi.mocked(fetchRun).mockResolvedValueOnce(runAtVersion(7)).mockResolvedValueOnce(runAtVersion(8));
      const fetch = vi.spyOn(globalThis, "fetch");
      if (failure === "transport") fetch.mockRejectedValueOnce(new TypeError("network lost"));
      else fetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: failure }), { status: failure === "conflict" ? 409 : 503 }));
      fetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
      const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const hook = renderHook(() => {
        const abandon = useAbandonCohort("run");
        const retry = useRetryStuck("run");
        return () => action === "abandon" ? abandon.mutateAsync({ cohortId: "cohort", detail: "stop" })
          : retry.mutateAsync({ stageInstanceId: "stage", unitId: "unit" });
      }, { wrapper });
      await act(async () => { await expect(hook.result.current()).rejects.toThrow(); });
      expect(invalidate.mock.calls.length).toBe(failure === "conflict" ? 1 : 0);
      await act(async () => { await hook.result.current(); });
      type RequestBody = Pick<Parameters<typeof submitCohortRequest>[0], "id" | "expected_version" | "request">;
      const bodies = fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as RequestBody);
      expect(bodies[1]?.expected_version).toBe(failure === "conflict" ? 8 : 7);
      expect(bodies[1]?.id === bodies[0]?.id).toBe(failure !== "conflict");
      expect(fetchRun).toHaveBeenCalledTimes(failure === "conflict" ? 2 : 1);
    });
  }
}
