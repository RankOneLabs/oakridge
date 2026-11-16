import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";
import { useHashRoute } from "../../hooks/useHashRoute";
import { selectPromptReferences } from "../lib/prompt-editor";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorPromptVersionListing, OperatorSavePendingPromptRequest } from "../operator-contracts/http/prompt-versions";
import { StagePromptsEditing } from "../components/organisms/StagePromptsEditing";
import { selectStageInspector } from "../lib/stage-inspector";
import { savePendingPrompt, validatePendingPrompt } from "../client-prompt-versions";
import { acceptHashNavigation } from "../../lib/hash";
import { definitionSelectionHref, definitionTabHref } from "../lib/definition-selection";
const definition = fixture.definition as unknown as OperatorDefinitionDetail;
let listing: OperatorPromptVersionListing;
let conflict: boolean;
let invalid: boolean;
let moves: boolean;
let retired: boolean;
let retiredRead = false;
let saved: OperatorSavePendingPromptRequest | null;
const path = "development/brief.md";
beforeEach(() => {
  conflict = false; invalid = false; moves = true; retired = false; saved = null;
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
      if (moves) retired = true;
      listing = {...listing, published: {...listing.published, version_id: "pending-digest", body: listing.pending?.body ?? ""}, pending: null};
      return Response.json({version_id: "pending-digest", prompt_id: "prompt", source_path: path, published_at: "now", moved: moves ? [{workflow: "development", definition_id: "new-definition-id", previous_definition_id: definition.definition_id, audience: "user", workflow_name: "Development"}] : []});
    }
    if (url.includes("/prompt-versions?")) return Response.json(listing);
    if (url.includes("/definitions?")) return Response.json({items: [definition], next_cursor: null});
    if (url.endsWith("/definitions/new-definition-id")) {
      // With a retired previous definition, give the new read network-like latency so a
      // re-render of the retired page can land before it resolves.
      if (retiredRead) await new Promise(resolve => setTimeout(resolve, 50));
      return Response.json({...definition, definition_id: "new-definition-id"});
    }
    if (url.endsWith("/definitions/" + definition.definition_id)) return retiredRead && retired ? Response.json({error: "not found"}, {status: 404}) : Response.json(definition);
    return Response.json({}, {status: 404});
  }));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
function mount(stage = "brief", client = new QueryClient({defaultOptions: {queries: {retry: false}}})) {
  const model = selectStageInspector(definition, {kind: "stage", stage, tab: "prompts"});
  if (!model) throw new Error("Missing fixture stage");
  return render(<QueryClientProvider client={client}><StagePromptsEditing model={model} /></QueryClientProvider>);
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
  for (const name of ["Save draft", "Discard local edits"]) {
    expect((screen.getByRole("button", {name}) as HTMLButtonElement).disabled).toBe(false);
  }
  for (const name of ["Validate saved draft", "Publish prompt", "Close editor"]) {
    expect((screen.getByRole("button", {name}) as HTMLButtonElement).disabled).toBe(true);
  }
  click("Save draft");
  await screen.findByText("Pending version saved · pending-digest");
  await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
  expect(saved).toEqual({path, body: "operator edit", expected_pending_version_id: null});
  expect(screen.getByText("Saved pending version pending-digest")).toBeTruthy();
  expect(within(screen.getByRole("region", {name: "Versions"})).getByText(/Pending · pending-digest/)).toBeTruthy();
  click("Validate saved draft"); await screen.findByText("Pending version is valid.");
  click("Publish prompt");
  await screen.findByText("Published · new definition new-definiti");
  await waitFor(() => expect(window.location.hash).toBe(definitionTabHref("new-definition-id", {kind: "stage", stage: "brief", tab: "prompts"}, "prompts")));
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
  await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
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
  expect(await validatePendingPrompt(path, listing.published.version_id)).toMatchObject({ok: false, feedback: {kind: "validation_failed", issues: [{path: ["prompts", "brief"], detail: "Invalid body"}]}});
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
  await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
  click("Publish prompt");
  await waitFor(() => expect(window.location.hash).toContain("new-definition-id"));
  await screen.findByTestId("or-def-detail");
  window.history.back();
  await waitFor(() => expect(window.location.hash).toContain(definition.definition_id));
  await screen.findByTestId("or-def-detail");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/definitions/" + definition.definition_id))).toBe(true);
});

test("publishing navigates to the new definition although the retired one is no longer served", async () => {
  retiredRead = true;
  try {
    window.history.replaceState(null, "", definitionTabHref(definition.definition_id, {kind: "stage", stage: "brief", tab: "prompts"}, "prompts"));
    render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><RoutedDefinition /></QueryClientProvider>);
    await screen.findByRole("button", {name: "Edit " + path});
    click("Edit " + path); await screen.findByLabelText("Prompt body");
    edit(); click("Save draft"); await screen.findByText("Pending version saved · pending-digest");
    await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
    click("Publish prompt");
    await waitFor(() => expect(window.location.hash).toContain("new-definition-id"));
    await screen.findByTestId("or-def-detail");
    expect(screen.queryByTestId("or-def-detail-error")).toBeNull();
  } finally { retiredRead = false; }
});

test("switching clean prompt editors does not ask for confirmation", async () => {
  mount("cohort");
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  click("Edit development/merge-confirmation.md");
  await screen.findByRole("heading", {name: "Editing development/merge-confirmation.md"});
  fireEvent.click(screen.getAllByRole("button", {name: "Edit development/build.md"})[0]);
  await screen.findByRole("heading", {name: "Editing development/build.md"});
  expect(confirm).not.toHaveBeenCalled();
});
test("declining a dirty editor switch preserves the open prompt and edits", async () => {
  mount("cohort");
  click("Edit development/merge-confirmation.md");
  await screen.findByLabelText("Prompt body");
  edit();
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  fireEvent.click(screen.getAllByRole("button", {name: "Edit development/build.md"})[0]);
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByRole("heading", {name: "Editing development/merge-confirmation.md"})).toBeTruthy();
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe("operator edit");
});

interface DeferredResponse {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}
function deferResponse(): DeferredResponse {
  let resolve: DeferredResponse["resolve"] = () => {};
  const promise = new Promise<Response>(complete => { resolve = complete; });
  return {promise, resolve};
}
test("cached clean editor adopts fresh bodies and concurrency tokens", async () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  client.setQueryData(["oakridge", "prompt-versions", path], {ok: true, value: listing});
  const fresh = {...listing.published, version_id: "new-published", body: "new published body"};
  listing = {...listing, published: fresh, pending: {...fresh, version_id: "new-pending", status: "pending", body: "new saved body"}};
  const read = deferResponse();
  const baseFetch = fetch;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).includes("/prompt-versions?") ? read.promise : baseFetch(input, init)));
  mount("brief", client); click("Edit " + path);
  await screen.findByLabelText("Prompt body");
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe(definition.prompts[path].body);
  // Subsequent invalidation reads use the normal mock, not the consumed Response.
  vi.stubGlobal("fetch", baseFetch);
  await act(async () => { read.resolve(Response.json(listing)); });
  await waitFor(() => expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe("new saved body"));
  click("Publish prompt");
  await screen.findByText("Published · new definition new-definiti");
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/publish"));
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({path, expected_pending_version_id: "new-pending", expected_published_version_id: "new-published"});
});
test("fresh versions do not replace unsaved edits", async () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  mount("brief", client); click("Edit " + path); await screen.findByLabelText("Prompt body"); edit();
  listing = {...listing, pending: {...listing.published, version_id: "another-pending", body: "another saved body", status: "pending"}};
  await act(async () => { await client.refetchQueries({queryKey: ["oakridge", "prompt-versions", path]}); });
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe("operator edit");
  click("Save draft"); await screen.findByText("Pending version saved · pending-digest");
  await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
  expect(saved?.expected_pending_version_id).toBeNull();
});
test("validation refuses a pending version that differs from the editor's saved draft", async () => {
  await open(); edit(); click("Save draft"); await screen.findByText("Pending version saved · pending-digest");
  await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
  listing = {...listing, pending: {...listing.published, version_id: "another-pending", body: "another saved body", status: "pending"}};
  click("Validate saved draft");
  await screen.findByText(/Conflict: the prompt changed/);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/validate"))).toBe(false);
  expect((screen.getByLabelText("Prompt body") as HTMLTextAreaElement).value).toBe("operator edit");
});
test.each(["navigation", "unmount"])("slow publication respects later %s", async departure => {
  const view = mount(); click("Edit " + path); await screen.findByLabelText("Prompt body");
  edit(); click("Save draft"); await screen.findByText("Pending version saved · pending-digest");
  await waitFor(() => expect((screen.getByRole("button", {name: "Validate saved draft"}) as HTMLButtonElement).disabled).toBe(false));
  const publication = deferResponse();
  const baseFetch = fetch;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/publish") ? publication.promise : baseFetch(input, init)));
  click("Publish prompt");
  const previous = window.location.hash;
  if (departure === "unmount") view.unmount();
  else {
    await act(async () => { await new Promise<void>(resolve => {
      window.addEventListener("hashchange", () => resolve(), {once: true});
      window.location.hash = "#settings";
    }); });
    // A return to the same URL must still cancel the old publication's navigation.
    await act(async () => { await new Promise<void>(resolve => {
      window.addEventListener("hashchange", () => resolve(), {once: true});
      window.location.hash = previous;
    }); });
  }
  await act(async () => { publication.resolve(await baseFetch("/publish", {method: "POST"})); });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/definitions/new-definition-id"))).toBe(true));
  expect(window.location.hash).toBe(previous);
});
