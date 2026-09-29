import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { usePostSessionMessage } from "./usePostMessage";
import { useSessionMessageDelivery } from "./usePingThread";
import { useSessionMessages } from "./useThreads";
import type { SessionMessageRecord } from "../types";

const message: SessionMessageRecord = {
  id: "message-row-1", run_id: "run/1", cohort_id: "cohort/1",
  sender: { kind: "agent", id: "builder" }, recipient: { kind: "agent", id: "reviewer" },
  thread_id: "review", message_id: "message-1", artifact_thread_id: null, body: { text: "review" },
  delivery_key: "delivery/1", delivery_status: "failed", delivery_result: { kind: "failed", detail: "retry limit reached" },
  created_at: "2026-09-28T12:00:00Z", delivered_at: null,
};

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const subject = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
};

afterEach(() => vi.restoreAllMocks());

test("useSessionMessages reads the cohort view from the backend", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json([message]));
  const { wrapper } = subject();
  const hook = renderHook(() => useSessionMessages("run/1", "cohort/1"), { wrapper });
  await waitFor(() => expect(hook.result.current.data).toEqual([message]));
  expect(fetch).toHaveBeenCalledWith("/oakridge/api/runs/run%2F1/messages?cohort_id=cohort%2F1");
});

test("useSessionMessageDelivery exposes the committed backend result", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json(message));
  const { wrapper } = subject();
  const hook = renderHook(() => useSessionMessageDelivery("run/1", "delivery/1"), { wrapper });
  await waitFor(() => expect(hook.result.current.data?.delivery_result).toEqual({ kind: "failed", detail: "retry limit reached" }));
  expect(hook.result.current.data?.delivery_status).toBe("failed");
});

test("usePostSessionMessage sends the durable key and caches the returned delivery state", async () => {
  const accepted = { kind: "accepted" as const, message, workflow_id: "workflow-1" };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(accepted));
  const { client, wrapper } = subject();
  client.setQueryData(["oakridge", "run", "run/1", "messages", null], []);
  const hook = renderHook(() => usePostSessionMessage("run/1"), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({
      delivery_key: "delivery/1",
      message: { sender: message.sender, recipient: message.recipient, thread_id: message.thread_id, message_id: message.message_id, body: message.body },
    });
  });
  expect(fetch).toHaveBeenCalledWith("/oakridge/api/runs/run%2F1/messages", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "delivery/1" }),
  }));
  expect(client.getQueryData(["oakridge", "run", "run/1", "message", "delivery/1"])).toEqual(message);
  expect(client.getQueryState(["oakridge", "run", "run/1", "messages", null])?.isInvalidated).toBe(true);
});
