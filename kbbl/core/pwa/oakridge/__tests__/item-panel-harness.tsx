// Shared item-panel IO boundary harness; extracted to keep the component suite small.
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { acknowledged, correctnessQuestion, findingRow, id, IMPLEMENTATION, INTEGRATION, ANALYSIS, item, itemStatus, OCCURRENCE, paged, reviewerAnswer, supportQuestion, taskComposite } from "../__fixtures__/grading";
import { ItemPanel } from "../components/organisms/ItemPanel";
import type { ObservationItemStatusResponse } from "../grading-contracts/storage/grading-record-store";
import { useGradingVisibility } from "../state/gradingVisibility";

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });
interface Harness { status: ObservationItemStatusResponse; own: readonly ReturnType<typeof reviewerAnswer>[]; submit: () => Response | Promise<Response>; sent: unknown[]; paths: string[] }
export let world: Harness;
const reads = (path: string): Response | null => {
  if (path === "/oakridge/observation/reviewer") return json({ reviewer_id: id("oakridge-operator") });
  if (path.endsWith("/items/at")) return json(world.status.item);
  if (path.endsWith("/status")) return json(world.status);
  if (path.endsWith("/lineage") && path.includes("/items/")) return json({ occurrence_id: OCCURRENCE, relations: [], total: 0, limit: 20, offset: 0, republication: null });
  if (path.endsWith("/answers")) return json(paged(world.own));
  if (path.endsWith("/grading")) return json({ run_id: id("run-1"), is_grading_enabled: false, committed: 0.13, requests_sent: 13, attempts: 13, executions: { completed: 3 } });
  if (path.endsWith("/tasks")) return json(paged([taskComposite()]));
  if (path.endsWith("/tasks/T1")) return json(taskComposite());
  if (path.endsWith("/tasks/T404")) return json({ error: { code: "not_found", message: "no such task" } }, 404);
  if (/\/tasks\/[^/]+\/lineage$/.test(path)) return json({ ...paged([{ kind: "contribution", relation_id: id("rel-1"), evidence_ref: "e", asserted_by: "producer_explicit", item: item(IMPLEMENTATION) }]), run_id: id("run-1"), producer_local_id: "T1", is_captured: true });
  if (path.endsWith("/unresolved-task-references")) return json(paged([{ item: item(IMPLEMENTATION), relation_id: id("rel-2"), unresolved_target_ref: "logical_item:task:T404", evidence_ref: "e" }]));
  if (path.endsWith("/drilldown")) return json(paged([{ item: item(IMPLEMENTATION), links: paged([]), questions: paged([{ question: { question_id: id("assessment_finding.evidence_support"), question_version: "1" }, evidence: supportQuestion().evidence, statuses: paged([]),
    answers: paged([reviewerAnswer("raw-answer", "does_not_support", "second-reviewer")]), superseded_answers: paged([]) }]) }]));
  return null;
};
beforeEach(() => {
  world = { status: itemStatus([supportQuestion(), correctnessQuestion()]), own: [], submit: () => json(acknowledged("supports"), 201), sent: [], paths: [] };
  useGradingVisibility.setState({ revealed_item_keys: new Set(), revealed_composite_run_ids: new Set() });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://kbbl.test");
    world.paths.push(url.pathname + url.search);
    if (init?.method === "POST") { world.sent.push(JSON.parse(String(init.body))); return world.submit(); }
    if (url.pathname.endsWith("/findings")) {
      const stage = url.searchParams.get("stage");
      if (stage === "analysis") return json(paged([findingRow(ANALYSIS, { stage: "analysis", selected_value: { description: "analysis finding" } })]));
      if (stage === "implementation") return json(paged([findingRow(IMPLEMENTATION, {}, paged([{ state: "unresolved", producer_local_id: "T404", unresolved_target_ref: "logical_item:task:T404", relation_id: id("r"), evidence_ref: "e" }]))]));
      return json(paged([findingRow(INTEGRATION, { stage: "integration", selected_value: { description: "unlinked integration finding" } })]));
    }
    return reads(url.pathname) ?? json({ error: { code: "unexpected", message: url.pathname } }, 404);
  }) as typeof fetch);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

export const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })}>{node}</QueryClientProvider>);
export const panel = (onOpenTask = vi.fn()) => wrap(<ItemPanel runId="run-1" selection={IMPLEMENTATION} onOpenTask={onOpenTask} />);
