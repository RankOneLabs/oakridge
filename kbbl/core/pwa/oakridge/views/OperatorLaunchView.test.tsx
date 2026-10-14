import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { OperatorLaunchView } from "./OperatorLaunchView";
import { fetchOperatorDefinitions } from "../client";
import { makeSpecFile, makeDefinitionSummary } from "../__fixtures__/read-models";

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

test("an older file read cannot replace the newly selected spec file", async () => {
  vi.mocked(fetchOperatorDefinitions).mockResolvedValue([makeDefinitionSummary()]);
  renderView();
  const picker = await screen.findByLabelText<HTMLInputElement>("Load spec from file");
  let finishOldRead: (text: string) => void = () => { throw new Error("old read was not started"); };
  const oldFile = makeSpecFile("old.md", 5, () => new Promise<string>((resolve) => { finishOldRead = resolve; }));
  fireEvent.change(picker, { target: { files: [oldFile] } });
  fireEvent.change(picker, { target: { files: [makeSpecFile("new.md", 5, "New spec")] } });
  await screen.findByText("Loaded new.md");
  await act(async () => { finishOldRead("Old spec"); });
  expect(screen.getByLabelText<HTMLInputElement>("spec").value).toBe("New spec");
  expect(screen.queryByText("Loaded old.md")).toBeNull();
});

test("switching definitions discards an unfinished spec file read", async () => {
  vi.mocked(fetchOperatorDefinitions).mockResolvedValue([makeDefinitionSummary(), makeDefinitionSummary({ digest: "digest-2" })]);
  renderView();
  await screen.findByText(/digest-2/);
  fireEvent.change(screen.getByLabelText("Definition digest"), { target: { value: "digest-1" } });
  const picker = await screen.findByLabelText<HTMLInputElement>("Load spec from file");
  let finishRead: (text: string) => void = () => { throw new Error("read was not started"); };
  fireEvent.change(picker, { target: { files: [makeSpecFile("old.md", 5,
    () => new Promise<string>((resolve) => { finishRead = resolve; }))] } });
  fireEvent.change(screen.getByLabelText("Definition digest"), { target: { value: "digest-2" } });
  await act(async () => { finishRead("Old spec"); });
  expect(screen.getByLabelText<HTMLInputElement>("spec").value).toBe("");
  expect(screen.queryByText("Loaded old.md")).toBeNull();
});
