import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GradingConfigBrowser } from "../components/organisms/GradingConfigBrowser";
import { GradingConfigView } from "../views/GradingConfigView";
import { GradingConfigFeedback } from "../components/molecules/GradingConfigFeedback";
import { configDefinitions, configRead, publishedConfig } from "./grading-config-fixture";
import { readHashRoute } from "../../lib/hash";
import { atPath, replaceAtPath, type GradingFeedback } from "../lib/grading-config";
import type { ObservationJsonValue as Json } from "../grading-contracts/domain/primitives";
interface SentRequest { readonly path: string; readonly method: string; readonly body: Json | null }
let sent: SentRequest[];
const response = (body: unknown, status = 200) => Response.json(body, { status });
const failure = (kind: string, extra = {}) => response({ error: { operation: "grading_publication", entity_id: "draft", kind, code: kind, message: "detail", detail: "detail", ...extra } }, kind === "invalid_configuration" ? 422 : 409);
beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) as Json : null;
    sent.push({ path, method, body });
    if (path.endsWith("/draft") && method === "PUT") return response({ digest: "draft-saved", document: { status: "draft", definitions: atPath(body, ["document", "definitions"]) } });
    if (path.endsWith("/draft")) return response(configRead().draft);
    if (path.endsWith("/versions")) return response(configRead().versions);
    if (path.includes("/versions/")) return response(publishedConfig(Number(path.split("/").at(-1))));
    if (path.endsWith("/catalogue")) return response(configRead().catalogue);
    if (path.endsWith("/runtime")) return response(configRead().runtime);
    if (path.endsWith("/validate")) return response({ valid: true });
    if (path.endsWith("/publish")) return response({ outcome: "published", version: 4, hash: "new-hash", published_at: "now" }, 201);
    return response({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const browser = (options: { version?: number; onNavigate?: (version: number | null) => void } = {}) => render(<GradingConfigBrowser initial={{ ...configRead(), selected: options.version ? publishedConfig(options.version) : null }} version={options.version ?? null} onNavigate={options.onNavigate ?? vi.fn()} onReload={vi.fn()} />);
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (text: string) => fireEvent.click(screen.getByRole("button", { name: text }));

describe("grading configuration browser and structured sections", () => {
  it("parses both slash-prefixed routes and existing shell route spelling", () => {
    expect(readHashRoute("#/oakridge/grading-config", "")).toEqual({ view: "oakridge", route: { sub: "grading-config", version: null } });
    expect(readHashRoute("#oakridge/grading-config/versions/3", "")).toEqual({ view: "oakridge", route: { sub: "grading-config", version: 3 } });
  });
  it("loads only the proxy routes and renders latest timestamp, saved draft and every definition summary", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GradingConfigView version={null} onNavigate={vi.fn()} /></QueryClientProvider>);
    await screen.findByTestId("grading-config-browser");
    expect(screen.getByText("Latest published version 3 · 2026-11-12T12:00:00Z")).toBeTruthy();
    expect(screen.getByTestId("grading-draft-status").textContent).toBe("Saved draft");
    expect(screen.getAllByTestId("grading-definition-summary")[0]?.textContent).toContain("analysis /findings/*");
    expect(screen.getAllByTestId("grading-definition-summary")[0]?.textContent).toContain("subject");
    expect(screen.getByLabelText("Question text")).toBeTruthy();
    expect(sent.every((request) => request.path.startsWith("/oakridge/observation/grading-config/"))).toBe(true);
  });
  it("edits generic question, catalogue targets, evidence params and all three runner instruction contracts by path", async () => {
    browser();
    change("Question text", "New question"); change("Response type", "ordinal");
    change("Allowed values (JSON list or null)", '["weak","strong"]'); change("Missing evidence policy", "fail");
    change("abstain semantics", "No evidence"); change("unclear semantics", "Uncertain answer"); change("interpretation caveats", "Consider scope");
    change("Scope", "per_task"); change("Task pointer (task_ids JSON pointer)", "/task_ids");
    change("Artifact kind 1", "assessment"); change("Item selector 1", "/items/*");
    change("Evidence capability 1", "citation"); click("Add optional params"); change("Evidence params 1 (JSON)", '{"path":"file.ts"}');
    expect(screen.getByText("Parameter JSON Schema")).toBeTruthy();
    change("System One instructions 1", "New direct instructions"); change("Criteria 1 (JSON)", '{"yes":"Good","no":"Bad"}');
    change("System One type 2", "noul"); change("Criteria 2 (JSON)", '{"true":"Good","false":"Bad"}'); change("State fields 2 (optional JSON)", '["subject"]');
    change("Rubric 3", "New rubric"); change("Max evidence chars 3 (integer 1..32000)", "9000"); change("Model 3", "new-model");
    click("Save draft"); await screen.findByText("Draft saved · draft-saved");
    const saved = sent.find((request) => request.method === "PUT")?.body;
    expect(atPath(saved, ["document", "definitions", 0])).toMatchObject({ scope: "per_task", task_ids: "/task_ids", question: { text: "New question", response: "ordinal", values: ["weak", "strong"], missing_evidence_policy: "fail" }, targets: [{ artifact: "assessment", selector: "/items/*" }], evidence: [{ capability: "citation", params: { path: "file.ts" } }], evaluators: [{ instructions: { system_one: { instructions: "New direct instructions", criteria: { yes: "Good" } } } }, { instructions: { system_one: { type: "noul" }, state_fields: ["subject"] } }, { model: "new-model", instructions: { rubric: "New rubric", max_evidence_chars: 9000 } }] });
  });
  it("supports arbitrary definitions, unregistered runner JSON and human evaluators without question-specific types", () => {
    browser(); click("Add definition"); change("Definition id", "arbitrary"); click("Add evaluator");
    expect(screen.queryByLabelText("Model 1")).toBeNull();
    change("Runner 1", "llm_judge"); expect(screen.getByLabelText("Rubric 1")).toBeTruthy();
    click("Remove definition");
    click("Raw JSON");
    change("Whole definitions array (raw JSON)", JSON.stringify([{ id: "future", evaluators: [{ runner: "new-runner", instructions: {} }] }]));
    click("Structured sections"); expect(screen.getByLabelText("Instructions 1 (JSON)")).toBeTruthy();
  });
  it("keeps raw parse errors local and blocks save, publish and leaving raw mode", async () => {
    browser(); click("Raw JSON"); change("Whole definitions array (raw JSON)", "[");
    expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Structured sections" }).hasAttribute("disabled")).toBe(true);
    expect(sent).toEqual([]);
    change("Whole definitions array (raw JSON)", '[{"id":"new"}]'); click("Structured sections");
    expect((screen.getByLabelText("Definition id") as HTMLTextAreaElement).value).toBe("new");
    expect(screen.getByTestId("grading-draft-status").textContent).toBe("Unsaved local edits");
  });
  it("shows and saves raw replacements instead of cached structured JSON text", async () => {
    browser(); change("Allowed values (JSON list or null)", '["weak"]'); click("Raw JSON");
    const replacement = JSON.parse((screen.getByLabelText("Whole definitions array (raw JSON)") as HTMLTextAreaElement).value) as Json;
    change("Whole definitions array (raw JSON)", JSON.stringify(replaceAtPath(replacement, [0, "question", "values"], ["strong"]))); click("Structured sections");
    expect(JSON.parse((screen.getByLabelText("Allowed values (JSON list or null)") as HTMLTextAreaElement).value)).toEqual(["strong"]);
    click("Save draft"); await screen.findByText("Draft saved · draft-saved");
    expect(atPath(sent.find((request) => request.method === "PUT")?.body, ["document", "definitions", 0, "question", "values"])).toEqual(["strong"]);
  });
  it("blocks save on malformed section JSON and retains it when selecting a different definition", () => {
    browser(); change("Allowed values (JSON list or null)", "[");
    expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Raw JSON" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText("Allowed values (JSON list or null)") as HTMLTextAreaElement).value).toBe("[");
    change("Allowed values (JSON list or null)", "null");
    expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(false);
  });
  it("shows published versions read-only, with an initialize action", () => {
    browser({ version: 1 }); expect(screen.getByText("Published version 1 · read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByLabelText("Question text")).toBeNull();
    expect(screen.getByRole("button", { name: "Initialize draft from this version" })).toBeTruthy();
  });
});

describe("shared draft operations", () => {
  it("saves optimistic draft digest, preserves content on conflict and keeps publish disabled until save succeeds", async () => {
    browser(); change("Question text", "Unsaved question");
    expect(screen.getByRole("button", { name: "Publish configuration" }).hasAttribute("disabled")).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(failure("draft_conflict", { current_digest: "other" }));
    click("Save draft"); await screen.findByText(/Draft conflict/);
    expect((screen.getByLabelText("Question text") as HTMLTextAreaElement).value).toBe("Unsaved question");
    expect(screen.getByTestId("grading-draft-status").textContent).toBe("Unsaved local edits");
    click("Save draft"); await screen.findByText("Draft saved · draft-saved");
    expect(atPath(sent.at(-1)?.body, ["expected_draft_digest"])).toBe("draft-base");
    click("Publish configuration"); await screen.findByText("Published version 4 · new-hash");
    expect(sent.find((request) => request.path.endsWith("/publish"))?.body).toEqual({ expected_draft_digest: "draft-saved", expected_latest_version: 3 });
  });
  it("retains edits after a network save failure", async () => {
    browser(); change("Question text", "Keep me"); vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    click("Save draft"); await screen.findByText("Request failed: offline");
    expect((screen.getByLabelText("Question text") as HTMLTextAreaElement).value).toBe("Keep me");
    expect(screen.getByTestId("grading-draft-status").textContent).toBe("Unsaved local edits");
  });
  it("shows only in-progress feedback until publication is confirmed", async () => {
    browser(); let complete: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    click("Publish configuration"); expect(screen.getByTestId("grading-config-feedback").textContent).toBe("Publishing configuration…");
    expect(screen.queryByText(/Published version 4/)).toBeNull();
    complete?.(failure("version_conflict", { current_latest_version: 5 }));
    await screen.findByText(/Version conflict/); expect(screen.queryByText(/Published version 4/)).toBeNull();
  });
  it("places service validation issues on the matching definition section", async () => {
    browser(); vi.mocked(fetch).mockResolvedValueOnce(failure("invalid_configuration", { issues: [{ definition_index: 0, path: [0, "evaluators", 1, "instructions"], detail: "Recipe is incomplete" }] }));
    click("Validate saved draft"); await screen.findByText("Validation failed. Review the issues below.");
    expect(within(screen.getByRole("region", { name: "Evaluators" })).getByRole("alert").textContent).toContain("Recipe is incomplete");
    expect(within(screen.getByRole("region", { name: "Question" })).queryByRole("alert")).toBeNull();
  });
  it("places id validation issues beside the Definition id field", async () => {
    browser(); vi.mocked(fetch).mockResolvedValueOnce(failure("invalid_configuration", { issues: [{ definition_index: 0, path: [0, "id"], detail: "Definition id must be unique" }] }));
    click("Validate saved draft"); await screen.findByText("Validation failed. Review the issues below.");
    expect(within(screen.getByRole("group", { name: "Definition id field" })).getByRole("alert").textContent).toBe("Definition id must be unique");
  });
  it("shows an empty-path definition issue once in the editor, outside its sections", async () => {
    browser(); vi.mocked(fetch).mockResolvedValueOnce(failure("invalid_configuration", { issues: [{ definition_index: 0, path: [], detail: "Definition is incomplete" }] }));
    click("Validate saved draft"); await screen.findByText("Validation failed. Review the issues below.");
    const editor = within(screen.getByTestId("grading-definition-editor"));
    expect(editor.getAllByText("Definition is incomplete")).toHaveLength(1);
    for (const section of ["Question", "Targets", "Evidence", "Evaluators"]) {
      expect(within(editor.getByRole("region", { name: section })).queryByRole("alert")).toBeNull();
    }
  });
  it("compares local field paths and restores a version only after confirmation, using the current digest", async () => {
    browser(); change("Question text", "Local revision"); click("Compare with latest");
    expect(screen.getByTestId("grading-config-diff").textContent).toContain("definitions.0.question.text");
    click("Initialize draft from version 1"); click("Keep editing"); expect(sent).toEqual([]);
    expect((screen.getByLabelText("Question text") as HTMLTextAreaElement).value).toBe("Local revision");
    click("Initialize draft from version 1"); click("Replace draft"); await screen.findByText("Draft saved · draft-saved");
    expect(sent.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(sent[0]?.path).toContain("/versions/1");
    expect(sent[1]?.body).toEqual({ expected_draft_digest: "draft-base", document: { status: "draft", definitions: configDefinitions } });
    expect((screen.getByLabelText("Question text") as HTMLTextAreaElement).value).toBe("Is the finding useful?");
  });
  it("leaves unsaved content intact when initializing from an old version fails", async () => {
    browser(); change("Question text", "Local revision"); click("Initialize draft from version 1");
    const base = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => init?.method === "PUT" ? failure("draft_conflict", { current_digest: "other" }) : base ? base(input, init) : response(null));
    click("Replace draft"); await screen.findByText(/Draft conflict/);
    expect((screen.getByLabelText("Question text") as HTMLTextAreaElement).value).toBe("Local revision");
    expect(screen.getByTestId("grading-draft-status").textContent).toBe("Unsaved local edits");
  });
});
const feedbackCases: readonly GradingFeedback[] = [
  { kind: "saving" }, { kind: "saved", digest: "digest" }, { kind: "validating" }, { kind: "validated" }, { kind: "validation_failed", issues: [] }, { kind: "publishing" },
  ...(["published", "unchanged", "reapplied"] as const).map((kind) => ({ kind, version: 4, hash: "hash" })),
  ...(["registration_failed", "persistence_failed", "runtime_apply_failed"] as const).map((failure) => ({ kind: "runtime_failed" as const, failure, detail: "detail" })),
  { kind: "conflict", target: "draft" }, { kind: "conflict", target: "version" }, { kind: "restart_required", detail: "credential" }, { kind: "transport_error", detail: "offline" },
];
it.each(feedbackCases)("renders distinct operation feedback $kind", (feedback) => {
  render(<GradingConfigFeedback feedback={feedback} />);
  expect(screen.getByRole("status").getAttribute("data-kind")).toBe(feedback.kind);
  expect(screen.getByRole("status").textContent?.length).toBeGreaterThan(5);
});
