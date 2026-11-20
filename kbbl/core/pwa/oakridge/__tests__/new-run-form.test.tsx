import { installStatus } from "../__fixtures__/install-status";
import type { OperatorInstallStatus } from "../operator-contracts/projections/install-status-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import definitionFixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorLaunchRequest } from "../operator-contracts/http/ingress";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { CreateRunRequest } from "../launch-types";
import { workflowLaunch } from "../adapters/launch";

const definition = definitionFixture.definition as unknown as OperatorDefinitionDetail;
const study: OperatorDefinitionDetail = { ...definition, definition_id: "study-def", bundle: { ...definition.bundle, key: "study" } };
const definitionFor = (id: string) => id === study.definition_id ? study : definition;
let servedStatus: OperatorInstallStatus = installStatus;
const launches: OperatorLaunchRequest[] = [];

vi.mock("../client-projects", () => ({ fetchProjects: async () => [] }));

vi.mock("../client", () => ({
  fetchInstallStatus: async () => servedStatus,
  fetchOakridgeConfig: async () => ({ available: true, core_url: "http://oakridge.test" }),
  // fan-out is a test fixture with no PWA launch mapping, so the form must not offer it.
  fetchWorkflowDefs: async () => [{ id: definition.definition_id, name: "development" }, { id: study.definition_id, name: "study" }, { id: "fan-out-def", name: "fan-out" }],
  fetchOperatorDefinition: async (id: string) => definitionFor(id),
  // The launch request is the one the real adapter sends for this form's request.
  createRun: async (body: CreateRunRequest, idempotency_key: string) => {
    const mapped = workflowLaunch(body, definitionFor(body.workflow_def_id), idempotency_key);
    if (!mapped.ok) throw new Error(mapped.error.detail);
    launches.push(mapped.value);
    return { id: "run-1" };
  },
}));

const { NewRunForm } = await import("../components/organisms/NewRunForm");

beforeEach(() => {
  launches.length = 0;
  servedStatus = installStatus;
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

it("offers development and study, and no workflow the PWA cannot launch", async () => {
  renderForm();
  await waitFor(() => expect(document.querySelector(`option[value="${definition.definition_id}"]`)).toBeTruthy());
  const options = screen.getByLabelText("Workflow Definition").querySelectorAll("option");
  expect(Array.from(options, (option) => option.textContent)).toEqual(["development", "study"]);
});

async function chooseStudy() {
  await screen.findByTestId("or-new-run-automatic-grading-input");
  await waitFor(() => expect(document.querySelector(`option[value="${study.definition_id}"]`)).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Workflow Definition"), { target: { value: study.definition_id } });
  return await screen.findByLabelText("Slice case limit") as HTMLInputElement;
}

describe("NewRunForm study launch", () => {
  it("asks for slice limits only when study is selected, prefilled with six cases and $10", async () => {
    renderForm();
    await screen.findByTestId("or-new-run-automatic-grading-input");
    const before = screen.queryByTestId("or-new-run-study-slice");
    const caseLimit = await chooseStudy();
    expect([before, caseLimit.value, (screen.getByLabelText("Slice spending cap (USD)") as HTMLInputElement).value]).toEqual([null, "6", "10.00"]);
  });

  it("launches a study with its slice limits in cents and no approved plan", async () => {
    const { onCreated } = renderForm();
    fireEvent.change(await chooseStudy(), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Slice spending cap (USD)"), { target: { value: "2.50" } });
    await fillAndSubmit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
    expect(launches.map(({ definition_id, input }) => ({ definition_id, input }))).toEqual([{ definition_id: study.definition_id,
      input: { title: "Grade it", spec: "Build it", repositories: [expect.objectContaining({ key: "repo" })], primary_repository_key: "repo", final_merge_policy: "require_merge",
        slice_case_limit: 4, slice_cap_cents: 250, approved_plan: null } }]);
  });

  it("refuses a study whose slice case limit is not a whole number, without launching", async () => {
    renderForm();
    fireEvent.change(await chooseStudy(), { target: { value: "1.5" } });
    await fillAndSubmit();
    expect([await screen.findByText("Slice case limit must be a whole number of at least 1."), launches]).toEqual([expect.anything(), []]);
  });
});

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

it("disables launch with the selected definition's served preflight reason", async () => {
  servedStatus = { ...installStatus, launch_blocks: [{ definition_id: definition.definition_id, definition_name: "development", error: { kind: "integration_none", integration: "none", definition_id: definition.definition_id, detail: "Selected integration cannot launch this definition", fix: "Choose github-cli" } }] };
  renderForm();
  await screen.findByText(/Selected integration cannot launch this definition/);
  expect((screen.getByRole("button", { name: "Start Run" }) as HTMLButtonElement).disabled).toBe(true);
});
it("leaves launch enabled for definitions absent from the served launch blocks", async () => {
  renderForm();
  await waitFor(() => expect((screen.getByRole("button", { name: "Start Run" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText(/Selected integration cannot launch/)).toBeNull();
});
