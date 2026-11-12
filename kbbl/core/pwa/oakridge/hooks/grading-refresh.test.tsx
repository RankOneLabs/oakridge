import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { id, IMPLEMENTATION, item, itemStatus, OCCURRENCE, paged, reviewerAnswer, supportQuestion, taskComposite } from "../__fixtures__/grading";
import { useCompositeDrilldown } from "./useCompositeDrilldown";
import { useItemLineage } from "./useItemLineage";
import { useItemStatus } from "./useItemStatus";

const clients: QueryClient[] = [];
const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
const advance = async (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); });

test("an open drilldown refreshes completed answers and later reviewer corrections", async () => {
  vi.useFakeTimers();
  let revision = 0;
  const first = reviewerAnswer("first", "supports");
  const corrected = reviewerAnswer("corrected", "does_not_support", "oakridge-operator", { supersedes_observation_id: first.observation_id });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(paged([{ item: item(IMPLEMENTATION), links: paged([]), questions: paged([{
    question: supportQuestion().question, evidence: supportQuestion().evidence,
    statuses: paged(revision === 0 ? [{ question: supportQuestion().question, evaluator_definition_id: id("jev"), execution_id: id("execution"), status: { state: "pending" }, detail: null }] : []),
    answers: paged(revision === 0 ? [] : [revision === 1 ? first : corrected]), superseded_answers: paged(revision > 1 ? [first] : []),
  }]) }])));
  const request = { run_id: "run-1", key: taskComposite().stages.items[1]!.items, page: { limit: 20, offset: 0 }, nested: {} };
  const hook = renderHook(() => useCompositeDrilldown(request), { wrapper: wrapper() });
  await advance(1);
  expect(hook.result.current.data?.items[0]?.questions.items[0]?.statuses.items[0]?.status.state).toBe("pending");
  revision = 1;
  await advance(10_001);
  expect(hook.result.current.data?.items[0]?.questions.items[0]?.answers.items[0]?.observation_id).toBe("first");
  revision = 2;
  await advance(10_001);
  const question = hook.result.current.data?.items[0]?.questions.items[0];
  expect(question?.answers.items[0]?.observation_id).toBe("corrected");
  expect(question?.superseded_answers.items[0]?.observation_id).toBe("first");
});

test("an open item's lineage refreshes late links and resolved references", async () => {
  vi.useFakeTimers();
  let isResolved = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ occurrence_id: OCCURRENCE,
    relations: isResolved ? [{ relation_id: id("relation"), source_occurrence_id: OCCURRENCE, target_occurrence_id: null,
      target_logical_item_id: id("task"), unresolved_target_ref: null, type: "belongs_to", asserted_by: "producer_explicit", evidence_ref: "declaration" }] : [],
    total: isResolved ? 1 : 0, limit: 20, offset: 0, republication: null }));
  const hook = renderHook(() => useItemLineage(OCCURRENCE, { limit: 20, offset: 0 }), { wrapper: wrapper() });
  await advance(1);
  expect(hook.result.current.data?.relations).toEqual([]);
  isResolved = true;
  await advance(10_001);
  expect(hook.result.current.data?.relations[0]?.target_logical_item_id).toBe("task");
});

test("lineage polling stays idle until an occurrence is captured", async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, "fetch");
  renderHook(() => useItemLineage(null, { limit: 20, offset: 0 }), { wrapper: wrapper() });
  await advance(30_000);
  expect(fetch).not.toHaveBeenCalled();
});

test("an open item's status still polls for newly ready subjects by default", async () => {
  vi.useFakeTimers();
  let isReady = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(itemStatus([supportQuestion({ human: isReady
    ? { state: "ready" } : { state: "not_ready", code: "task_unavailable", detail: "task not captured" } })])));
  const request = { occurrence_id: OCCURRENCE, top: { limit: 200, offset: 0 }, nested: {} };
  const hook = renderHook(() => useItemStatus(request), { wrapper: wrapper() });
  await advance(1);
  expect(hook.result.current.data?.questions.items[0]?.human.state).toBe("not_ready");
  isReady = true;
  await advance(10_001);
  expect(hook.result.current.data?.questions.items[0]?.human.state).toBe("ready");
});
