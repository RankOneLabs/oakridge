// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeCommand, makeCommandReceipt, makeDevelopmentSchemas, makeScopeView } from "../__fixtures__/read-models";
import { GateDecisionActions } from "../components/organisms/GateDecisionActions";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const approve = makeCommand({ payload_schema: "text" });

describe("GateDecisionActions on generated scope targets", () => {
  test("submits the selected edited revision as the observed command target", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(makeCommandReceipt()));
    vi.stubGlobal("fetch", fetch);
    const scope = makeScopeView({ commands: [approve], command_targets: {
      approve: [{ identity: "revision-edited", version: 2 }],
    } });
    render(<GateDecisionActions scope={scope} revisionId="revision-edited" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Submit Approve" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(request.targets).toEqual([{ identity: "revision-edited", version: 2 }]);
  });

  test("shows a decision only for its observed revision after a revision switch", () => {
    const scope = makeScopeView({ commands: [approve], command_targets: {
      approve: [{ identity: "revision-edited", version: 2 }],
    } });
    const view = render(<GateDecisionActions scope={scope} revisionId="revision-root" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
    view.rerender(<GateDecisionActions scope={scope} revisionId="revision-edited" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();
  });

  test("ignores completion of a previous revision's command after switching revisions", async () => {
    let resolvePrevious: ((response: Response) => void) | undefined;
    const fetch = vi.fn(async () => new Promise<Response>((resolve) => { resolvePrevious = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const onRefresh = vi.fn();
    const first = makeScopeView({ commands: [approve], command_targets: {
      approve: [{ identity: "revision-a", version: 1 }],
    } });
    const next = makeScopeView({ commands: [approve], command_targets: {
      approve: [{ identity: "revision-b", version: 2 }],
    } });
    const view = render(<GateDecisionActions scope={first} revisionId="revision-a" schemas={makeDevelopmentSchemas()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Submit Approve" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<GateDecisionActions scope={next} revisionId="revision-b" schemas={makeDevelopmentSchemas()} onRefresh={onRefresh} />);
    await act(async () => { resolvePrevious?.(Response.json(makeCommandReceipt())); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText("Command accepted.")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();
  });

  test("removes decision controls when the scope no longer offers a command", () => {
    const fetch = vi.fn(async () => Response.json(makeCommandReceipt()));
    vi.stubGlobal("fetch", fetch);
    const actionable = makeScopeView({ commands: [approve], command_targets: {
      approve: [{ identity: "revision-1", version: 1 }],
    } });
    const view = render(<GateDecisionActions scope={actionable} revisionId="revision-1" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();
    view.rerender(<GateDecisionActions scope={makeScopeView({ is_terminal: true, commands: [] })}
      revisionId="revision-1" schemas={makeDevelopmentSchemas()} onRefresh={() => undefined} />);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
