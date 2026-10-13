// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeInboxDecision, makeInboxStalled, makeInboxWaiting, makeInboxPage } from "../__fixtures__/read-models";
import { ReviewInboxView } from "../views/ReviewInboxView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderInbox(items: ReturnType<typeof makeInboxPage>["items"], onSelectUnit = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(makeInboxPage({ items }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ReviewInboxView onSelectUnit={onSelectUnit} /></QueryClientProvider>);
  return onSelectUnit;
}

describe("ReviewInboxView generated work", () => {
  test("shows each actionable decision once and in projection order", async () => {
    renderInbox([
      makeInboxDecision({ unit_id: "unit-api", key: "admit", label: "Admit API" }),
      makeInboxDecision({ unit_id: "unit-web", key: "approve", label: "Review web artifact" }),
    ]);
    const rows = await screen.findAllByTestId("or-review-inbox-item");
    expect(rows.map((row) => row.querySelector("h2")?.textContent)).toEqual(["Admit API", "Review web artifact"]);
    expect(rows[0]?.querySelector("button")?.textContent).toBe("Open work");
  });

  test("opens the exact run and unit requiring attention", async () => {
    const onSelectUnit = renderInbox([makeInboxDecision({ run_id: "run-one", unit_id: "unit-web", label: "Review web artifact" })]);
    fireEvent.click((await screen.findByTestId("or-review-inbox-item")).querySelector("button")!);
    expect(onSelectUnit).toHaveBeenCalledWith("run-one", "unit-web");
  });

  test("names automatic waiting work without a direct decision control", async () => {
    renderInbox([makeInboxWaiting({ label: "Brief approved · queued automatically" })]);
    expect(await screen.findByText("Brief approved · queued automatically")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Submit/ })).toBeNull();
  });

  test("shows blocking diagnostic detail without an admission control", async () => {
    renderInbox([makeInboxStalled({ detail: "database blocks admission" })]);
    expect(await screen.findByText("database blocks admission")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Admit/ })).toBeNull();
  });

  test("labels merge confirmation separately from artifact review", async () => {
    renderInbox([makeInboxDecision({ key: "confirm_merge", label: "Confirm the merged pull request" })]);
    expect(await screen.findByText("Confirm the merged pull request")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open work" })).toBeTruthy();
  });

  test("surfaces a pull request diagnostic with its reconciliation detail", async () => {
    renderInbox([makeInboxStalled({ detail: "Pull request needs attention: observed pull request belongs to another repository" })]);
    const detail = await screen.findByText(/Pull request needs attention/);
    expect(detail.textContent).toContain("observed pull request belongs to another repository");
  });

  test("retains a settled row ahead of newly arrived work", async () => {
    const first = makeInboxDecision({ key: "brief-a", label: "Brief A" });
    const second = makeInboxDecision({ key: "brief-b", label: "Brief B" });
    const assessment = makeInboxDecision({ key: "assessment", label: "Assessment" });
    let items = [first, second];
    const fetch = vi.fn(async () => Response.json(makeInboxPage({ items })));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectUnit={() => undefined} /></QueryClientProvider>);
    await screen.findByText("Brief A");
    items = [assessment, second];
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getAllByTestId("or-review-inbox-item")).toHaveLength(3));
    expect(screen.getAllByTestId("or-review-inbox-item").map((row) =>
      `${row.getAttribute("data-state")}:${row.querySelector("h2")?.textContent}`))
      .toEqual(["settled:Brief A", "live:Brief B", "live:Assessment"]);
    expect(screen.getAllByTestId("or-review-inbox-item").map((row) => row.classList.contains("or-work-item--settled")))
      .toEqual([true, false, false]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
