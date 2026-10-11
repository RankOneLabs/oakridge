import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { OperatorLaunchView } from "./OperatorLaunchView";
import { fetchOperatorDefinitions } from "../client";
import { makeDefinitionSummary } from "../__fixtures__/read-models";

vi.mock("../client", () => ({ fetchOperatorDefinitions: vi.fn(async () => []), fetchOperatorProjects: async () => [], launchOperatorRun: vi.fn() }));

const PENDING_KEY = "oakridge:operator:pending-launch";
const renderView = () => render(<QueryClientProvider client={new QueryClient()}>
  <OperatorLaunchView onBack={() => {}} onCreated={() => {}} onEdit={() => {}} /></QueryClientProvider>);

beforeEach(() => { localStorage.clear(); vi.mocked(fetchOperatorDefinitions).mockResolvedValue([]); });
afterEach(cleanup);

test("discarding a pending launch removes the stored identity and unlocks the form", () => {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ request_id: "req-1", digest: "d1", input: {} }));
  renderView();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Root input JSON").disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Root input JSON").disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
});

test("unreadable stored launch state is surfaced and can be discarded", () => {
  localStorage.setItem(PENDING_KEY, "{not json");
  renderView();
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the pinned spec field loads file text and shows the selected filename", async () => {
  vi.mocked(fetchOperatorDefinitions).mockResolvedValue([makeDefinitionSummary()]);
  renderView();
  const picker = await screen.findByLabelText<HTMLInputElement>("Load spec from file");
  const file = new File(["# Ship"], "brief.md", { type: "text/plain" });
  Object.defineProperty(file, "text", { value: async () => "# Ship" });
  fireEvent.change(picker, { target: { files: [file] } });
  await screen.findByText("Loaded brief.md");
  expect(screen.getByLabelText<HTMLInputElement>("spec").value).toBe("# Ship");
});
