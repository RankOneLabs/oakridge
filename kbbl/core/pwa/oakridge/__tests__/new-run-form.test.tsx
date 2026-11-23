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
        ...base.bundle.schemas,
        { key: "study_plan", shape: { kind: "record", fields: [{ key: "outline", schema: "text" }] } },
        { key: "optional(study_plan)", shape: { kind: "optional", item: "study_plan" } },
      ],
    } };
}

const root = base.bundle.units.find((unit) => unit.key === base.bundle.root);
const shared = base.bundle.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
if (shared?.kind !== "record") throw new Error("Development fixture must have a record launch schema");
const study = definition("study", [...shared.fields,
  { key: "slice_case_limit", schema: "integer" }, { key: "slice_cap_cents", schema: "integer" },
  { key: "approved_plan", schema: "optional(study_plan)" },
]);
const definitions = [
  { ...base, definition_id: "development-def" },
  study,
  definition("folio", [{ key: "headline", schema: "text" }]),
];
const definitionFor = (id: string) => definitions.find((entry) => entry.definition_id === id)!;
let servedStatus: OperatorInstallStatus;
const launches: OperatorLaunchRequest[] = [];

vi.mock("../client-projects", () => ({ fetchProjects: async () => [{
  id: "docs", name: "Docs", repo_dir: "/docs", base_branch: "release", forge_repository: { owner: "acme", name: "docs" },
}] }));

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

async function fillEpicFields(title = "Grade it") {
  fireEvent.change(await screen.findByLabelText("Epic title"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Repository 1 GitHub owner"), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText("Repository 1 GitHub name"), { target: { value: "api" } });
  fireEvent.change(screen.getByLabelText("Repository 1 path"), { target: { value: "/repo" } });
  fireEvent.change(screen.getByLabelText("Brief notes"), { target: { value: "Build it" } });
}

async function submit() {
  const button = screen.getByRole("button", { name: "Start Run" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

it.each([false, true])("launches the independently declared workflow with grading %s", async (grading) => {
  const onCreated = renderForm();
  await choose("folio");
  expect((await screen.findByLabelText("headline")).tagName).toBe("TEXTAREA");
  expect(screen.queryByLabelText("Epic title")).toBeNull();
  fireEvent.change(screen.getByLabelText("headline"), { target: { value: "Opening folio" } });
  const checkbox = screen.getByTestId("or-new-run-automatic-grading-input") as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(screen.getByTestId("or-new-run-automatic-grading-disclosure").textContent).toBe(
    "When on, this run's spec and repository content are sent to the configured grading provider.");
  if (grading) fireEvent.click(checkbox);
  await submit();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(launches).toMatchObject([{ definition_id: "folio-def", input: { headline: "Opening folio" }, config: { grading_enabled: grading } }]);
});

it("submits study's approved plan as JSON", async () => {
  const onCreated = renderForm();
  await choose("study");
  await fillEpicFields();
  fireEvent.change(await screen.findByLabelText("approved plan"), { target: { value: '{"outline":"Verify the pilot"}' } });
  await submit();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(launches[0]?.input).toMatchObject({ slice_case_limit: 6, slice_cap_cents: 1000, approved_plan: { outline: "Verify the pilot" } });
});

it.each([["{", /valid JSON/], ["[]", /does not match/]])("refuses an invalid study plan %s", async (value, error) => {
  renderForm();
  await choose("study");
  await fillEpicFields();
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

it("maps a development launch from repository rows, merge policy and the selected grading setting", async () => {
  const onCreated = renderForm();
  await choose("development");
  await fillEpicFields();
  expect(screen.queryByLabelText("Slice case limit")).toBeNull();
  expect(screen.queryByLabelText("primary repository key")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "repositories" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Repository 1 key"), { target: { value: "api" } });
  fireEvent.click(screen.getByRole("button", { name: "+ Repository" }));
  fireEvent.change(screen.getByLabelText("Project for additional repository"), { target: { value: "docs" } });
  fireEvent.change(screen.getByLabelText(/Final merge policy/), { target: { value: "external_confirmation" } });
  fireEvent.click(screen.getByTestId("or-new-run-automatic-grading-input"));
  await submit();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(launches[0]).toMatchObject({ input: {
    title: "Grade it", spec: "Build it", primary_repository_key: "api", final_merge_policy: "allow_close_without_merge",
    repositories: [
      { key: "api", preparation: { repository_path: "/repo" }, forge: { name: "api", build_base: "epic/grade-it", final_base: "main" } },
      { key: "docs", preparation: { repository_path: "/docs" }, forge: { name: "docs", build_base: "epic/grade-it", final_base: "release" } },
    ],
  }, config: { grading_enabled: true } });
});

it("refuses an epic title that cannot name a branch", async () => {
  renderForm();
  await choose("development");
  await fillEpicFields("!!!");
  await submit();
  expect(await screen.findByText("Epic title must include a letter or number.")).toBeTruthy();
  expect(launches).toEqual([]);
});

it("prefills the study slice and submits dollars as cents with the guarded default", async () => {
  const onCreated = renderForm();
  await choose("study");
  await fillEpicFields();
  const cases = screen.getByLabelText("Slice case limit") as HTMLInputElement;
  const cap = screen.getByLabelText("Slice spending cap (USD)") as HTMLInputElement;
  expect([cases.value, cap.value]).toEqual(["6", "10.00"]);
  fireEvent.change(cases, { target: { value: "4" } });
  fireEvent.change(cap, { target: { value: "2.50" } });
  await submit();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(launches[0]).toMatchObject({ input: {
    final_merge_policy: "require_merge", slice_case_limit: 4, slice_cap_cents: 250, approved_plan: null,
  }, config: { grading_enabled: false } });
});

it("refuses a fractional study case limit", async () => {
  renderForm();
  await choose("study");
  await fillEpicFields();
  fireEvent.change(screen.getByLabelText("Slice case limit"), { target: { value: "1.5" } });
  await submit();
  expect(await screen.findByText("Slice case limit must be a whole number of at least 1.")).toBeTruthy();
  expect(launches).toEqual([]);
});
