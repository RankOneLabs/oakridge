import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { makeExecutionView, makeScopeView } from "../__fixtures__/read-models";
import { RunSidebarSessions } from "../components/molecules/RunSidebarSessions";
import { selectRunExecutions } from "../lib/run-sessions";

afterEach(cleanup);

it("the generated execution row opens its owning scope", () => {
  const onOpen = vi.fn();
  const scope = makeScopeView({ scope_id: "build-1", executions: [makeExecutionView({ id: "execution-1", status: "terminal" })] });
  render(<RunSidebarSessions executions={selectRunExecutions([scope])} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "author #1" }));
  expect(onOpen).toHaveBeenCalledWith("build-1");
  expect(screen.getByText("terminal")).toBeTruthy();
});

it("a scope with no executions renders an explicit empty state", () => {
  render(<RunSidebarSessions executions={selectRunExecutions([makeScopeView({ executions: [] })])} onOpen={() => undefined} />);
  expect(screen.getByText("No executions yet.")).toBeTruthy();
});
