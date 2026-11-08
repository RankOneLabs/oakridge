import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import definitionFixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorLaunchRequest } from "../operator-contracts/http/ingress";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { CreateRunRequest } from "../run-types";
import { developmentLaunch } from "../adapters/launch";

const definition = definitionFixture.definition as unknown as OperatorDefinitionDetail;
const launches: OperatorLaunchRequest[] = [];

vi.mock("../client", () => ({
  fetchOakridgeConfig: async () => ({ available: true, core_url: "http://oakridge.test" }),
  fetchProjects: async () => [],
  fetchWorkflowDefs: async () => [{ id: definition.definition_id, name: "development" }],
  fetchOperatorDefinition: async () => definition,
  // The launch request is the one the real adapter sends for this form's request.
  createRun: async (body: CreateRunRequest, idempotency_key: string) => {
    const mapped = developmentLaunch(body, definition, idempotency_key);
    if (!mapped.ok) throw new Error(mapped.error.detail);
    launches.push(mapped.value);
    return { id: "run-1" };
  },
}));

const { NewRunForm } = await import("../components/organisms/NewRunForm");

beforeEach(() => {
  launches.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCreated = vi.fn();
  render(<QueryClientProvider client={client}><NewRunForm onBack={() => undefined} onCreated={onCreated} /></QueryClientProvider>);
  return { onCreated };
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText("Ship account recovery"), { target: { value: "Grade it" } });
  fireEvent.change(screen.getByLabelText("Repository 1 GitHub owner"), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText("Repository 1 GitHub name"), { target: { value: "api" } });
  fireEvent.change(screen.getByLabelText("Repository 1 path"), { target: { value: "/repo" } });
  fireEvent.change(screen.getByLabelText("Brief notes"), { target: { value: "Build it" } });
  const submit = await screen.findByRole("button", { name: "Start Run" });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
}

describe("NewRunForm automatic grading", () => {
  it("shows Automatic grading off by default with the provider disclosure", async () => {
    renderForm();
    const input = await screen.findByTestId("or-new-run-automatic-grading-input");
    expect([screen.getByTestId("or-new-run-automatic-grading").textContent?.includes("Automatic grading"),
      (input as HTMLInputElement).checked, screen.getByTestId("or-new-run-automatic-grading-disclosure").textContent]).toEqual([
      true, false, "When on, this run's spec and repository content are sent to the configured grading provider."]);
  });

  it("launches with automatic grading off unless it is turned on", async () => {
    const { onCreated } = renderForm();
    await fillAndSubmit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
    expect(launches.map((launch) => launch.config?.grading_enabled)).toEqual([false]);
  });

  it("launches with the chosen automatic grading in the run's config", async () => {
    const { onCreated } = renderForm();
    fireEvent.click(await screen.findByTestId("or-new-run-automatic-grading-input"));
    await fillAndSubmit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
    expect(launches.map((launch) => launch.config?.grading_enabled)).toEqual([true]);
  });
});
