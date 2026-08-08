import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GateDecisionActions } from "../GateDecisionActions";
import type { ParkedGate, RepositoryKey } from "../types";

function gate(id: string, revision: string): ParkedGate {
  return {
    id,
    gate_type: "artifact_approval",
    gate_step: "artifact_approval",
    run_id: "run-1",
    stage_name: "build",
    unit_id: "web",
    repository_key: "web" as RepositoryKey,
    artifact_revision_id: revision,
    worktree: null,
    resume_actions: ["approve", "request_revision"],
    pr_url: null,
  };
}

function wrapper(client: QueryClient, value: ParkedGate, onComplete = vi.fn()) {
  return (
    <QueryClientProvider client={client}>
      <GateDecisionActions gate={value} onComplete={onComplete} />
    </QueryClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("GateDecisionActions", () => {
  it("resets decision state on a gate switch and ignores the previous gate response", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const onComplete = vi.fn();
    const view = render(wrapper(client, gate("gate-a", "revision-a"), onComplete));

    fireEvent.click(screen.getByTestId("or-decision-approve"));
    view.rerender(wrapper(client, gate("gate-b", "revision-b"), onComplete));
    await waitFor(() => expect(screen.getByTestId("or-decision-approve")).toBeTruthy());

    await act(async () => {
      resolveRequest?.(new Response(JSON.stringify({ gate_id: "gate-a", resumed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.queryByTestId("or-decision-success")).toBeNull();
    expect(screen.getByTestId("or-decision-approve")).toBeTruthy();
  });

  it("uses a new idempotency key when feedback changes", async () => {
    const requests: Array<{ feedback: string; idempotency_key: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { feedback: string; idempotency_key: string });
      return new Response(JSON.stringify({ detail: "try again" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(wrapper(client, gate("gate-a", "revision-a")));

    fireEvent.click(screen.getByTestId("or-decision-request_revision"));
    fireEvent.change(screen.getByLabelText("What needs to change?"), { target: { value: "First explanation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await screen.findByRole("alert");

    fireEvent.change(screen.getByLabelText("What needs to change?"), { target: { value: "Better explanation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(requests).toHaveLength(2));

    expect(requests.map((request) => request.feedback)).toEqual(["First explanation", "Better explanation"]);
    expect(requests[0].idempotency_key).not.toBe(requests[1].idempotency_key);
  });
});
