import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { makeAttemptView, makeUnitView } from "../__fixtures__/read-models";
import { RunSidebarSessions } from "../components/molecules/RunSidebarSessions";
import { selectRunAttempts } from "../lib/run-sessions";

afterEach(cleanup);

it("an attempt row opens its unit", () => {
  const onOpen = vi.fn();
  const unit = makeUnitView({ unit_id: "build-1", attempts: [makeAttemptView({ id: "attempt-1", status: "succeeded" })] });
  render(<RunSidebarSessions attempts={selectRunAttempts([unit])} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "author #1" }));
  expect(onOpen).toHaveBeenCalledWith("build-1");
  expect(screen.getByText("succeeded")).toBeTruthy();
});

it("a unit with no attempts renders an explicit empty state", () => {
  render(<RunSidebarSessions attempts={selectRunAttempts([makeUnitView({ attempts: [] })])} onOpen={() => undefined} />);
  expect(screen.getByText("No attempts yet.")).toBeTruthy();
});
