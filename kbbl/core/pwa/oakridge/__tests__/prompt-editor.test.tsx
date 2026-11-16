import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";
import { useHashRoute } from "../../hooks/useHashRoute";
import { selectPromptReferences } from "../lib/prompt-editor";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorPromptVersionListing, OperatorSavePendingPromptRequest } from "../operator-contracts/http/prompt-versions";
import { StagePromptsSection } from "../components/molecules/StagePromptsSection";
import { selectStageInspector } from "../lib/stage-inspector";
import { savePendingPrompt, validatePendingPrompt } from "../client-prompt-versions";
import { acceptHashNavigation } from "../../lib/hash";
import { definitionSelectionHref, definitionTabHref } from "../lib/definition-selection";
const definition = fixture.definition as unknown as OperatorDefinitionDetail;
let listing: OperatorPromptVersionListing;
let conflict: boolean;
let invalid: boolean;
let moves: boolean;
let saved: OperatorSavePendingPromptRequest | null;
const path = "development/brief.md";
beforeEach(() => {
  conflict = false; invalid = false; moves = true; saved = null;
  const published = {version_id: "published-digest", prompt_id: "prompt", source_path: path, body: definition.prompts[path].body, status: "published" as const, published_at: "2026-11-15"};
  listing = {source_path: path, published, pending: null, versions: [published], referenced_by: []};
  window.location.hash = definitionSelectionHref(definition.definition_id, {kind: "stage", stage: "brief", tab: "prompts"});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const error = (kind: string) => Response.json({error: {operation: "prompt_versions", kind, detail: "store refused", entity_id: path, issues: [{workflow: "development", path: ["prompts", "brief"], detail: "Invalid body"}]}}, {status: kind === "invalid_prompt" ? 422 : 409});
    if (url.endsWith("/pending")) {
      saved = JSON.parse(String(init?.body)) as OperatorSavePendingPromptRequest;
      if (conflict) return error("pending_conflict");
      const pending = {...listing.published, body: saved.body, version_id: "pending-digest", status: "pending" as const, published_at: null};
      listing = {...listing, pending, versions: [...listing.versions.filter(version => version.status !== "pending"), pending]};
      return Response.json(pending);
    }
    if (url.endsWith("/validate")) return invalid ? error("invalid_prompt") : Response.json({valid: true, workflows: ["development"]});
    if (url.endsWith("/publish")) {
      listing = {...listing, published: {...listing.published, version_id: "pending-digest", body: listing.pending?.body ?? ""}, pending: null};
      return Response.json({version_id: "pending-digest", prompt_id: "prompt", source_path: path, published_at: "now", moved: moves ? [{workflow: "development", definition_id: "new-definition-id", previous_definition_id: definition.definition_id, audience: "user", workflow_name: "Development"}] : []});
    }
    if (url.includes("/prompt-versions?")) return Response.json(listing);
    if (url.includes("/definitions?")) return Response.json({items: [definition], next_cursor: null});
    if (url.endsWith("/definitions/new-definition-id")) return Response.json({...definition, definition_id: "new-definition-id"});
    if (url.endsWith("/definitions/" + definition.definition_id)) return Response.json(definition);
    return Response.json({}, {status: 404});
  }));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
function mount(stage = "brief") {
  const model = selectStageInspector(definition, {kind: "stage", stage, tab: "prompts"});
  if (!model) throw new Error("Missing fixture stage");
  return render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><StagePromptsSection model={model} /></QueryClientProvider>);
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", {name}));
async function open() {mount(); click("Edit " + path); await screen.findByRole("region", {name: "Prompt editor"});}
const edit = () => fireEvent.change(screen.getByLabelText("Prompt body"), {target: {value: "operator edit"}});
test("opens the authored body and published version history", async () => {
  await open();
  expect(screen.getByRole("heading", {name: "Editing " + path})).toBeTruthy();
  expect(screen.getByText("Source: " + path)).toBeTruthy();
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe(definition.prompts[path].body);
  expect(within(screen.getByRole("region", {name: "Versions"})).getByText(/Published · published-digest.*current/)).toBeTruthy();
});
test("shared review lists both stage uses and template references remain visible", async () => {
  mount("cohort"); click("Edit development/merge-confirmation.md");
  const region = await screen.findByRole("region", {name: "Prompt editor"});
  expect(within(region).getByText("Shared prompt: saving and publishing changes it for every use listed below.")).toBeTruthy();
  expect(within(region).getByText("development › cohort › merge_confirmation (review)")).toBeTruthy();
  expect(within(region).getByText("development › integration › merge_confirmation (review)")).toBeTruthy();
});
test("edit save validate publish sends preconditions and pushes the reported definition", async () => {
  await open(); edit();
  expect(screen.getByText("Unsaved local edits")).toBeTruthy();
  expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(true);
  click("Save draft");
  await screen.findByText("Pending version saved · pending-digest");
  expect(saved).toEqual({path, body: "operator edit", expected_pending_version_id: null});
  expect(screen.getByText("Saved pending version pending-digest")).toBeTruthy();
  expect(within(screen.getByRole("region", {name: "Versions"})).getByText(/Pending · pending-digest/)).toBeTruthy();
  click("Validate saved draft"); await screen.findByText("Pending version is valid.");
  click("Publish prompt");
  await screen.findByText("Published · new definition new-definiti");
  await waitFor(() => expect(window.location.hash).toBe(definitionSelectionHref("new-definition-id", {kind: "stage", stage: "brief", tab: "prompts"})));
});
test("conflict preserves the edited textarea", async () => {
  conflict = true; await open(); edit(); click("Save draft");
  await screen.findByText(/Conflict: the prompt changed/);
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe("operator edit");
});
test("declined stage navigation leaves draft and URL intact", async () => {
  await open(); edit(); vi.stubGlobal("confirm", vi.fn(() => false));
  const previous = window.location.href;
  window.location.hash = definitionSelectionHref(definition.definition_id, {kind: "stage", stage: "cohort", tab: null});
  expect(acceptHashNavigation()).toBe(false);
  expect(window.location.href).toBe(previous);
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe("operator edit");
});
test("validation refusal lists store issues and publication without a move keeps the URL", async () => {
  await open(); edit(); click("Save draft"); await screen.findByText("Pending version saved · pending-digest");
  invalid = true; click("Validate saved draft");
  await screen.findByText("Validation failed. Review the issues below.");
  expect(screen.getByText("prompts.brief: Invalid body")).toBeTruthy();
  moves = false;
  const previous = window.location.hash;
  click("Publish prompt"); await screen.findByText("Published");
  expect(window.location.hash).toBe(previous);
});
test("client preserves conflicts, validation issues, and network error messages", async () => {
  conflict = true;
  expect(await savePendingPrompt({path, body: "edit", expected: null})).toEqual({ok: false, feedback: {kind: "conflict"}});
  listing = {...listing, pending: {...listing.published, status: "pending"}};
  invalid = true;
  expect(await validatePendingPrompt(path)).toMatchObject({ok: false, feedback: {kind: "validation_failed", issues: [{path: ["prompts", "brief"], detail: "Invalid body"}]}});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(await savePendingPrompt({path, body: "edit", expected: null})).toEqual({ok: false, feedback: {kind: "transport_error", detail: "offline"}});
});


test("templated workers show their authored template name", async () => {
  const reference = Object.keys(definition.prompts).flatMap(promptPath =>
    selectPromptReferences({path: promptPath, definitions: [definition]}).map(reference => ({...reference, path: promptPath}))
  ).find(reference => reference.template !== null);
  if (!reference) throw new Error("Missing template fixture");
  mount(reference.stage);
  fireEvent.click(screen.getAllByRole("button", {name: "Edit " + reference.path})[0]);
  const editor = await screen.findByRole("region", {name: "Prompt editor"});
  expect(within(editor).getAllByText(new RegExp("from template " + reference.template)).length).toBeGreaterThan(0);
});
function RoutedDefinition() {
  const route = useHashRoute();
  if (route?.view !== "settings" || route.route.sub !== "workflow") return null;
  return <WorkflowDefDetail definitionId={route.route.id} selection={route.route.selection}
    onNavigate={href => {window.location.hash = href;}} onBack={() => window.history.back()} />;
}
test("published navigation preserves Back access to the mocked previous definition detail", async () => {
  window.history.replaceState(null, "", definitionTabHref(definition.definition_id, {kind: "stage", stage: "brief", tab: "prompts"}, "prompts"));
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><RoutedDefinition /></QueryClientProvider>);
  await screen.findByRole("button", {name: "Edit " + path});
  click("Edit " + path); await screen.findByLabelText("Prompt body");
  edit(); click("Save draft"); await screen.findByText("Pending version saved · pending-digest");
  click("Publish prompt");
  await waitFor(() => expect(window.location.hash).toContain("new-definition-id"));
  await screen.findByTestId("or-def-detail");
  window.history.back();
  await waitFor(() => expect(window.location.hash).toContain(definition.definition_id));
  await screen.findByTestId("or-def-detail");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/definitions/" + definition.definition_id))).toBe(true);
});
