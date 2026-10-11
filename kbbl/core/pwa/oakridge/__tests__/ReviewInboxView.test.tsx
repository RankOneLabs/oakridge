// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeInboxCommand, makeInboxDiagnostic, makeInboxWait, makeReviewInbox } from "../__fixtures__/read-models";
import { ReviewInboxView } from "../views/ReviewInboxView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderInbox(items: ReturnType<typeof makeReviewInbox>["items"], onSelectScope = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(makeReviewInbox({ items }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ReviewInboxView onSelectScope={onSelectScope} /></QueryClientProvider>);
  return onSelectScope;
}

describe("ReviewInboxView generated work", () => {
  test("shows each actionable command once and in projection order", async () => {
    renderInbox([
      makeInboxCommand({ scope_id: "scope-api", key: "admit", label: "Admit API" }),
      makeInboxCommand({ scope_id: "scope-web", key: "approve", label: "Review web artifact" }),
    ]);
    const rows = await screen.findAllByTestId("or-review-inbox-item");
    expect(rows.map((row) => row.querySelector("h2")?.textContent)).toEqual(["Admit API", "Review web artifact"]);
    expect(rows[0]?.querySelector("button")?.textContent).toBe("Open work");
  });

  test("opens the exact run and scope requiring attention", async () => {
    const onSelectScope = renderInbox([makeInboxCommand({ run_id: "run-one", scope_id: "scope-web", label: "Review web artifact" })]);
    fireEvent.click((await screen.findByTestId("or-review-inbox-item")).querySelector("button")!);
    expect(onSelectScope).toHaveBeenCalledWith("run-one", "scope-web");
  });

  test("names automatic waiting work without a direct decision control", async () => {
    renderInbox([makeInboxWait({ label: "Brief approved · queued automatically" })]);
    expect(await screen.findByText("Brief approved · queued automatically")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Submit/ })).toBeNull();
  });

  test("shows blocking diagnostic detail without an admission control", async () => {
    renderInbox([makeInboxDiagnostic({ detail: "database blocks admission" })]);
    expect(await screen.findByText("database blocks admission")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Admit/ })).toBeNull();
  });

  test("labels merge confirmation separately from artifact review", async () => {
    renderInbox([makeInboxCommand({ key: "confirm_merge", label: "Confirm the merged pull request" })]);
    expect(await screen.findByText("Confirm the merged pull request")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open work" })).toBeTruthy();
  });

  test("surfaces a pull request diagnostic with its reconciliation detail", async () => {
    renderInbox([makeInboxDiagnostic({ detail: "Pull request needs attention: observed pull request belongs to another repository" })]);
    const detail = await screen.findByText(/Pull request needs attention/);
    expect(detail.textContent).toContain("observed pull request belongs to another repository");
  });

  test("retains a settled row ahead of newly arrived work", async () => {
    const first = makeInboxCommand({ key: "brief-a", label: "Brief A" });
    const second = makeInboxCommand({ key: "brief-b", label: "Brief B" });
    const assessment = makeInboxCommand({ key: "assessment", label: "Assessment" });
    let items = [first, second];
    const fetch = vi.fn(async () => Response.json(makeReviewInbox({ items })));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectScope={() => undefined} /></QueryClientProvider>);
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
