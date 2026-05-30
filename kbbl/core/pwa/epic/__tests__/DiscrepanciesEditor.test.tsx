import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { DiscrepanciesEditor } from "../DiscrepanciesEditor";

const OPEN_ROW = {
  id: "disc-1",
  spec_assumption: "Cache is invalidated on write",
  code_reality: "Cache is never invalidated",
  status: "open",
  resolution: null,
};

const RESOLVED_ROW = {
  id: "disc-2",
  spec_assumption: "Retries are exponential",
  code_reality: "No retry logic exists",
  status: "resolved",
  resolution: "Added retry middleware",
};

function makeFetch(rows: unknown[]) {
  return vi.fn().mockImplementation((url: unknown, init?: unknown) => {
    if (
      typeof url === "string" &&
      url.includes("/spec-discrepancies") &&
      !(init && (init as RequestInit).method === "PATCH")
    ) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(rows),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

interface PatchBody {
  resolution?: string;
  status?: string;
  internal_status?: string;
}

function findPatchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  urlPattern: string,
): { body: PatchBody } | null {
  for (const args of fetchMock.mock.calls as unknown[][]) {
    const url = args[0];
    const init = args[1] as RequestInit | undefined;
    if (typeof url === "string" && url.includes(urlPattern) && init?.method === "PATCH") {
      return { body: JSON.parse(init.body as string) as PatchBody };
    }
  }
  return null;
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiscrepanciesEditor", () => {
  it("Resolve PATCH happy path: calls PATCH with status=resolved", async () => {
    const fetchMock = makeFetch([OPEN_ROW]);
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <DiscrepanciesEditor spec_id="spec-1" epic_id="epic-1" internal_status="discrepancies" />,
    );

    const input = await screen.findByPlaceholderText("Resolution note…");
    fireEvent.change(input, { target: { value: "fixed it" } });

    const resolveBtn = screen.getByRole("button", { name: "Resolve" });
    expect((resolveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(resolveBtn);

    await waitFor(() => {
      const call = findPatchCall(fetchMock, "/spec-discrepancies/disc-1");
      if (!call) throw new Error("expected PATCH /spec-discrepancies/disc-1 not found");
      expect(call.body.status).toBe("resolved");
      expect(call.body.resolution).toBe("fixed it");
    });
  });

  it("Waive PATCH happy path: calls PATCH with status=waived", async () => {
    const fetchMock = makeFetch([OPEN_ROW]);
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <DiscrepanciesEditor spec_id="spec-1" epic_id="epic-1" internal_status="discrepancies" />,
    );

    const input = await screen.findByPlaceholderText("Resolution note…");
    fireEvent.change(input, { target: { value: "not applicable" } });

    fireEvent.click(screen.getByRole("button", { name: "Waive" }));

    await waitFor(() => {
      const call = findPatchCall(fetchMock, "/spec-discrepancies/disc-1");
      if (!call) throw new Error("expected PATCH /spec-discrepancies/disc-1 not found");
      expect(call.body.status).toBe("waived");
      expect(call.body.resolution).toBe("not applicable");
    });
  });

  it("Move to Review is disabled when an open row remains", async () => {
    vi.stubGlobal("fetch", makeFetch([OPEN_ROW, RESOLVED_ROW]));

    renderWithClient(
      <DiscrepanciesEditor spec_id="spec-1" epic_id="epic-1" internal_status="discrepancies" />,
    );

    const moveBtn = await screen.findByRole("button", { name: "Move to Review" });
    expect((moveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("Move to Review calls PATCH /specs/:id/internal-status when countOpen===0", async () => {
    const fetchMock = makeFetch([RESOLVED_ROW]);
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <DiscrepanciesEditor spec_id="spec-1" epic_id="epic-1" internal_status="discrepancies" />,
    );

    const moveBtn = await screen.findByRole("button", { name: "Move to Review" });
    expect((moveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(moveBtn);

    await waitFor(() => {
      const call = findPatchCall(fetchMock, "/specs/spec-1/internal-status");
      if (!call) throw new Error("expected PATCH /specs/spec-1/internal-status not found");
      expect(call.body.internal_status).toBe("review");
    });
  });

  it("shows Approve (not Move to Review) when internal_status is review", async () => {
    vi.stubGlobal("fetch", makeFetch([RESOLVED_ROW]));

    renderWithClient(
      <DiscrepanciesEditor spec_id="spec-1" epic_id="epic-1" internal_status="review" />,
    );

    expect(
      await screen.findByRole("button", { name: "Approve & start planning" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to Review" })).toBeNull();
  });

  it("Approve requires confirm, then PATCHes internal-status=approved", async () => {
    const fetchMock = makeFetch([RESOLVED_ROW]);
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <DiscrepanciesEditor spec_id="spec-1" epic_id="epic-1" internal_status="review" />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Approve & start planning" }),
    );

    // First click reveals a confirm step; no PATCH yet.
    expect(findPatchCall(fetchMock, "/specs/spec-1/internal-status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      const call = findPatchCall(fetchMock, "/specs/spec-1/internal-status");
      if (!call) throw new Error("expected PATCH /specs/spec-1/internal-status not found");
      expect(call.body.internal_status).toBe("approved");
    });
  });
});
