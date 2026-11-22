import { installStatus } from "../__fixtures__/install-status";
import type { OperatorInstallStatus } from "../operator-contracts/projections/install-status-view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import definitionFixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorLaunchRequest } from "../operator-contracts/http/ingress";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { CreateRunRequest } from "../launch-types";
import { workflowLaunch } from "../adapters/launch";

const base = definitionFixture.definition as unknown as OperatorDefinitionDetail;
function definition(name: string, fields: readonly { key: string; schema: string }[]): OperatorDefinitionDetail {
  return { ...base, definition_id: `${name}-def`, workflow: { ...base.workflow, workflow: name, stages: {} },
    graph: { nodes: [], edges: [] }, bundle: { key: name, root: "root", stages: [],
      units: [{ key: "root", stage: null, label: name, input_schema: "root input", artifacts: [] }],
      schemas: [
        { key: "root input", shape: { kind: "record", fields } },
        { key: "text", shape: { kind: "string", min_length: 1, max_length: 300 } },
        { key: "plan_body", shape: { kind: "record", fields: [{ key: "outline", schema: "text" }] } },
        { key: "optional(plan_body)", shape: { kind: "optional", item: "plan_body" } },
      ],
    } };
}

const definitions = [
  definition("development", [{ key: "title", schema: "text" }]),
  definition("study", [{ key: "approved_plan", schema: "optional(plan_body)" }]),
  definition("folio", [{ key: "headline", schema: "text" }]),
];
const definitionFor = (id: string) => definitions.find((entry) => entry.definition_id === id)!;
let servedStatus: OperatorInstallStatus;
const launches: OperatorLaunchRequest[] = [];

vi.mock("../client-projects", () => ({ fetchProjects: async () => [] }));

vi.mock("../client", () => ({
  fetchInstallStatus: async () => servedStatus,
  fetchWorkflowDefs: async () => definitions.map((entry) => ({ id: entry.definition_id, name: entry.bundle.key })),
  fetchOperatorDefinition: async (id: string) => definitionFor(id),
  createRun: async (body: CreateRunRequest, idempotencyKey: string) => {
    const mapped = workflowLaunch(body, definitionFor(body.workflow_def_id), idempotencyKey);
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
afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCreated = vi.fn();
  render(<QueryClientProvider client={client}><NewRunForm onBack={() => undefined} onCreated={onCreated} /></QueryClientProvider>);
  return onCreated;
}

async function choose(name: string) {
  await screen.findByRole("option", { name });
  fireEvent.change(screen.getByLabelText("Workflow Definition"), { target: { value: `${name}-def` } });
}

async function submit() {
  const button = screen.getByRole("button", { name: "Start Run" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

it.each([false, true])("launches the independently declared workflow with grading %s", async (grading) => {
  const onCreated = renderForm();
  await choose("folio");
  fireEvent.change(await screen.findByLabelText("headline"), { target: { value: "Opening folio" } });
  const checkbox = screen.getByTestId("or-new-run-automatic-grading-input") as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  if (grading) fireEvent.click(checkbox);
  await submit();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(launches).toMatchObject([{ definition_id: "folio-def", input: { headline: "Opening folio" }, config: { grading_enabled: grading } }]);
});

it("submits study's approved plan as JSON", async () => {
  const onCreated = renderForm();
  await choose("study");
  fireEvent.change(await screen.findByLabelText("approved plan"), { target: { value: '{"outline":"Verify the pilot"}' } });
  await submit();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(launches[0]?.input).toEqual({ approved_plan: { outline: "Verify the pilot" } });
});

it.each([["{", /valid JSON/], ["[]", /does not match/]])("refuses an invalid study plan %s", async (value, error) => {
  renderForm();
  await choose("study");
  fireEvent.change(await screen.findByLabelText("approved plan"), { target: { value } });
  await submit();
  expect(await screen.findByText(error)).toBeTruthy();
  expect(launches).toEqual([]);
});

it("disables launch with the selected definition's served preflight reason", async () => {
  servedStatus = { ...installStatus, launch_blocks: [{ definition_id: "development-def", definition_name: "development",
    error: { kind: "integration_none", integration: "none", definition_id: "development-def", detail: "Selected integration cannot launch this definition", fix: "Choose github-cli" } }] };
  renderForm();
  await choose("development");
  await screen.findByText(/Selected integration cannot launch this definition/);
  expect((screen.getByRole("button", { name: "Start Run" }) as HTMLButtonElement).disabled).toBe(true);
});

it("leaves launch enabled for definitions absent from the served launch blocks", async () => {
  renderForm();
  await choose("folio");
  await waitFor(() => expect((screen.getByRole("button", { name: "Start Run" }) as HTMLButtonElement).disabled).toBe(false));
});
