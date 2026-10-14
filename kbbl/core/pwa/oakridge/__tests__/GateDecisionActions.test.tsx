// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeDecision, makeIngressCommitted, makeDevelopmentSchemas, makeUnitView } from "../__fixtures__/read-models";
import { GateDecisionActions } from "../components/organisms/GateDecisionActions";

const renderGate = (ui: Parameters<typeof render>[0]) => render(ui, { wrapper: ({ children }) =>
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> });

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const approveOn = (target_revision_id: string) => makeDecision({ payload_schema: "{}",
  submit: { kind: "review", review: "analysis_review", decision: "approve", effect: "approve", target_revision_id } });

describe("GateDecisionActions on a revision", () => {
  test("submits the decision on the revision it targets", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(makeIngressCommitted()));
    vi.stubGlobal("fetch", fetch);
    const unit = makeUnitView({ decisions: [approveOn("revision-edited")] });
    renderGate(<GateDecisionActions unit={unit} revisionId="revision-edited" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Submit Approve" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect([request.decision, request.target]).toEqual(["approve", "revision-edited"]);
  });

  test("shows a decision only on its target revision after a revision switch", () => {
    const unit = makeUnitView({ decisions: [approveOn("revision-edited")] });
    const view = renderGate(<GateDecisionActions unit={unit} revisionId="revision-root" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
    view.rerender(<GateDecisionActions unit={unit} revisionId="revision-edited" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();
  });

  test("ignores completion of a previous revision's decision after switching revisions", async () => {
    let resolvePrevious: ((response: Response) => void) | undefined;
    const fetch = vi.fn(async () => new Promise<Response>((resolve) => { resolvePrevious = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const onRefresh = vi.fn();
    const first = makeUnitView({ decisions: [approveOn("revision-a")] });
    const next = makeUnitView({ decisions: [approveOn("revision-b")] });
    const view = renderGate(<GateDecisionActions unit={first} revisionId="revision-a" schemas={makeDevelopmentSchemas()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Submit Approve" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<GateDecisionActions unit={next} revisionId="revision-b" schemas={makeDevelopmentSchemas()} onRefresh={onRefresh} />);
    await act(async () => { resolvePrevious?.(Response.json(makeIngressCommitted())); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText("Decision accepted.")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();
  });

  test("removes decision controls when the unit no longer offers a decision", () => {
    const fetch = vi.fn(async () => Response.json(makeIngressCommitted()));
    vi.stubGlobal("fetch", fetch);
    const actionable = makeUnitView({ decisions: [approveOn("revision-1")] });
    const view = renderGate(<GateDecisionActions unit={actionable} revisionId="revision-1" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();
    view.rerender(<GateDecisionActions unit={makeUnitView({ is_terminal: true, decisions: [] })}
      revisionId="revision-1" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
