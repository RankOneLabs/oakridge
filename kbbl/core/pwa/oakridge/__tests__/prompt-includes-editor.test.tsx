import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StagePromptsEditing } from "../components/organisms/StagePromptsEditing";
import { selectStageInspector } from "../lib/stage-inspector";
import { SHARED_PROMPT, definitionWithIncludes as definition } from "../__fixtures__/definition-with-includes";
import type { OperatorPromptVersionListing } from "../operator-contracts/http/prompt-versions";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/prompt-versions")) {
      const path = url.searchParams.get("path") ?? "";
      const published = {version_id: "published-digest", prompt_id: "prompt", source_path: path, body: definition.prompts[path].body, status: "published" as const, published_at: "2026-11-19"};
      const listing: OperatorPromptVersionListing = {source_path: path, published, pending: null, versions: [published], referenced_by: []};
      return Response.json(listing);
    }
    if (url.pathname.endsWith("/definitions")) return Response.json({items: [definition], next_cursor: null});
    if (url.pathname.endsWith("/definitions/" + definition.definition_id)) return Response.json(definition);
    return Response.json({}, {status: 404});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  const model = selectStageInspector(definition, {kind: "stage", stage: "brief", tab: "prompts"});
  if (!model) throw new Error("Missing fixture stage");
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><StagePromptsEditing model={model} /></QueryClientProvider>);
}

test("a stage prompt lists the shared prompt it includes, which opens in its own editor", async () => {
  mount();
  fireEvent.click(screen.getAllByRole("button", {name: "Edit " + SHARED_PROMPT})[0]);
  const editor = await screen.findByRole("region", {name: "Prompt editor"});
  expect({heading: within(editor).getByRole("heading", {level: 3}).textContent, body: (within(editor).getByLabelText("Prompt body") as HTMLTextAreaElement).value})
    .toEqual({heading: "Editing " + SHARED_PROMPT, body: definition.prompts[SHARED_PROMPT].body});
});
test("a shared prompt's editor names each use and the prompt it reaches it through", async () => {
  mount();
  fireEvent.click(screen.getAllByRole("button", {name: "Edit " + SHARED_PROMPT})[0]);
  const editor = await screen.findByRole("region", {name: "Prompt editor"});
  expect(await within(editor).findByText("development › brief › writer (revise) · through development/brief-revise.md")).toBeTruthy();
  expect(within(editor).getByText("Shared prompt: saving and publishing changes it for every use listed below.")).toBeTruthy();
});
test("an including prompt's editor opens the prompt it includes", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", {name: "Edit development/brief.md"}));
  const editor = await screen.findByRole("region", {name: "Prompt editor"});
  fireEvent.click(within(editor).getByRole("button", {name: "Edit " + SHARED_PROMPT}));
  expect(await screen.findByRole("heading", {name: "Editing " + SHARED_PROMPT})).toBeTruthy();
});
