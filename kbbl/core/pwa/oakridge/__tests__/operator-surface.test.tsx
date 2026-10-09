import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OakridgeShell } from "../OakridgeShell";
import { OperatorLaunchView } from "../views/OperatorLaunchView";
import { OperatorHistoryPane } from "../views/OperatorHistoryPane";
import { OperatorDefinitionEditorView } from "../views/OperatorDefinitionEditorView";
import { GenericOperatorRunView } from "../views/GenericOperatorRunView";
import { savePendingCommand } from "../lib/operator-drafts";
import type { WorkflowDefinitionDescriptor } from "../workflow-definition-types";

function shippedBundle(name: string): unknown {
  const path = resolve(process.cwd(), `../../../workflow-config/definitions/${name}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  // PR 4's third bundle is absent at the integration baseline. Keep its extra
  // root field represented there so the test fails for the missing form behavior.
  if (name !== "development-verification") throw new Error(`Missing shipped bundle: ${name}`);
  const source = shippedBundle("development") as WorkflowDefinitionDescriptor;
  const root = source.scopes.find((scope) => scope.key === source.root);
  const input = source.schemas.find((schema) => schema.key === root?.input_schema);
  if (!root || input?.shape.kind !== "record" || !root.commands[0]) throw new Error("Invalid baseline bundle");
  return { ...source, key: name, schemas: [...source.schemas, { key: "test_extended_root", shape: { ...input.shape,
    fields: [...input.shape.fields, { key: "verification_note", schema: "optional_text", required: true }] } }],
    scopes: source.scopes.map((scope) => scope.key === root.key ? { ...scope, input_schema: "test_extended_root",
      commands: [...scope.commands, { ...root.commands[0], key: "test_extra", label: "Additional action" }] } : scope) };
}
const canonicalDefinition = shippedBundle("development") as { readonly version: number; readonly [key: string]: unknown };

/** Field kinds the launch form renders as a plain control; every other kind gets a JSON entry. */
const DIRECT_ENTRY_KINDS: readonly string[] = ["string", "integer", "boolean", "enum"];

function sampleSchemaValue(bundle: WorkflowDefinitionDescriptor, key: string): unknown {
  const shape = bundle.schemas.find((schema) => schema.key === key)?.shape;
  if (!shape) throw new Error(`Unknown schema: ${key}`);
  if (shape.kind === "string") return "sample";
  if (shape.kind === "integer") return shape.min;
  if (shape.kind === "boolean") return true;
  if (shape.kind === "enum") {
    const [variant] = shape.variants;
    if (variant === undefined) throw new Error(`Enum has no variants: ${key}`);
    return variant;
  }
  if (shape.kind === "list") return [];
  if (shape.kind === "optional") return null;
  if (shape.kind === "record") return Object.fromEntries(shape.fields.filter((field) => field.required)
    .map((field) => [field.key, sampleSchemaValue(bundle, field.schema)]));
  throw new Error(`No sample value for schema kind: ${shape.kind}`);
}

interface SampledRootField { readonly key: string; readonly label: string; readonly draft: string; readonly value: unknown }

/** Every root input field a bundle declares, with the label and entry text the form expects for it. */
function sampleRootFields(bundle: WorkflowDefinitionDescriptor): readonly SampledRootField[] {
  const root = bundle.scopes.find((scope) => scope.key === bundle.root);
  const shape = bundle.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
  if (shape?.kind !== "record") throw new Error("root input is not a record");
  return shape.fields.map((field) => {
    const kind = bundle.schemas.find((schema) => schema.key === field.schema)?.shape.kind;
    if (kind === undefined) throw new Error(`Unknown field schema: ${field.schema}`);
    const value = sampleSchemaValue(bundle, field.schema);
    return { key: field.key, value,
      label: `${field.key}${DIRECT_ENTRY_KINDS.includes(kind) ? "" : " JSON"}`,
      draft: kind === "string" || kind === "enum" ? String(value) : JSON.stringify(value) };
  });
}
const rootInputRecord = (fields: readonly SampledRootField[]): unknown =>
  Object.fromEntries(fields.map((field) => [field.key, field.value]));

/**
 * The root field the bundle declares as a required string whose schema admits "",
 * so a blank entry is a value the authority accepts rather than a missing input.
 */
function requiredEmptyStringField(bundle: WorkflowDefinitionDescriptor): SampledRootField {
  const root = bundle.scopes.find((scope) => scope.key === bundle.root);
  const shape = bundle.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
  if (shape?.kind !== "record") throw new Error("root input is not a record");
  const declared = shape.fields.find((field) => {
    const fieldShape = bundle.schemas.find((schema) => schema.key === field.schema)?.shape;
    return field.required && fieldShape?.kind === "string" && fieldShape.min_length === 0;
  });
  if (!declared) throw new Error("no required root string admits an empty value");
  const sampled = sampleRootFields(bundle).find((field) => field.key === declared.key);
  if (!sampled) throw new Error(`${declared.key} is not a sampled root field`);
  return sampled;
}

/**
 * The authority pages GET /api/runs and GET /api/definitions, so a mocked list
 * body carries the page envelope the client's CursorPage reads. A bare array
 * here would leave `page.items` undefined and fail inside readAllPages rather
 * than in the view under test.
 */
const cursorPage = (items: readonly unknown[]): Response => Response.json({ items, next_cursor: null });

/** Serves one pinned bundle and accepts the launch it produces. */
const launchFetch = (bundle: WorkflowDefinitionDescriptor) => vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/definitions")) return cursorPage([{ bundle_id: "pinned", digest: "pinned-digest", source: bundle }]);
  if (url.endsWith("/runs") && init?.method === "POST") return Response.json({ run_id: "new-run" }, { status: 201 });
  throw new Error(url);
});

/** Enters every sampled root field but the named one, which the test leaves to the form. */
function enterRootFieldsExcept(fields: readonly SampledRootField[], skipped: string): void {
  for (const field of fields) {
    if (field.key === skipped) continue;
    fireEvent.change(screen.getByLabelText(field.label), { target: { value: field.draft } });
  }
}

function renderWithQuery(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

test("pins the entered JSON definition", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/oakridge/api/api/definitions" && init?.method === "GET")
      return cursorPage([{ bundle_id: "seed", digest: "seed-digest", source: canonicalDefinition }]);
    if (url === "/oakridge/api/api/definitions" && init?.method === "POST") return Response.json({ bundle_id: "bundle-1", digest: "sha-1" }, { status: 201 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const onPinned = vi.fn();
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={onPinned} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("Source bundle"), { target: { value: JSON.stringify(canonicalDefinition) } });
  fireEvent.click(screen.getByRole("button", { name: "Pin definition" }));
  await waitFor(() => expect(onPinned).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toHaveProperty("root");
});

test("a new definition is not seeded from an arbitrary catalog entry", async () => {
  const other = { ...canonicalDefinition, key: "other" };
  vi.stubGlobal("fetch", vi.fn(async () => cursorPage([
    { bundle_id: "a", digest: "a-digest", source: canonicalDefinition }, { bundle_id: "b", digest: "b-digest", source: other }])));
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={() => undefined} />);
  await screen.findByLabelText("Source bundle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Source bundle").value).toBe("");
});

test("with several pinned definitions the operator must choose one before launching", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/definitions")) return cursorPage([
      { bundle_id: "b1", digest: "sha-1", source: { key: "alpha", version: 1 } },
      { bundle_id: "b2", digest: "sha-2", source: { key: "beta", version: 1 } }]);
    if (url.endsWith("/runs") && init?.method === "POST") return Response.json({ run_id: "run-1" }, { status: 201 });
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByText(/beta v1/);
  expect(screen.getByLabelText<HTMLSelectElement>("Definition digest").value).toBe("");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Launch" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Definition digest"), { target: { value: "sha-2" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Launch" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).digest).toBe("sha-2");
});

test("an empty catalog does not seed the editor from a bundled definition", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => cursorPage([])));
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={() => undefined} />);
  await screen.findByLabelText("Source bundle");
  expect(screen.getByLabelText<HTMLTextAreaElement>("Source bundle").value).toBe("");
});

test("the third bundle renders its extra root input as JSON and round-trips the raw editor", async () => {
  const bundle = shippedBundle("development-verification") as WorkflowDefinitionDescriptor;
  const fields = sampleRootFields(bundle);
  const extra = fields[fields.length - 1];
  if (!extra) throw new Error("root input has no fields");
  if (!extra.label.endsWith(" JSON")) throw new Error(`${extra.key} no longer needs a JSON fallback`);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/definitions")) return cursorPage([{ bundle_id: "third", digest: "third-digest", source: bundle }]);
    if (url.endsWith("/runs") && init?.method === "POST") return Response.json({ run_id: "new-run" }, { status: 201 });
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText(extra.label);
  for (const field of fields) fireEvent.change(screen.getByLabelText(field.label), { target: { value: field.draft } });
  fireEvent.click(screen.getByLabelText("Raw JSON"));
  expect(JSON.parse(screen.getByLabelText<HTMLTextAreaElement>("Root input JSON").value)).toEqual(rootInputRecord(fields));
  fireEvent.click(screen.getByLabelText("Raw JSON"));
  expect(JSON.parse(screen.getByLabelText<HTMLTextAreaElement>(extra.label).value)).toEqual(extra.value);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input).toEqual(rootInputRecord(fields));
});

test.each(["development", "development-independent-siblings", "development-verification"])(
  "%s drives launch, commands, history and receipt recovery from its pinned source", async (name) => {
    const bundle = shippedBundle(name) as WorkflowDefinitionDescriptor;
    const root = bundle.scopes.find((scope) => scope.key === bundle.root);
    if (!root) throw new Error("root scope missing");
    const inputShape = bundle.schemas.find((schema) => schema.key === root.input_schema)?.shape;
    if (inputShape?.kind !== "record") throw new Error("root input is not a record");
    const recoveryCommand = root.commands[root.commands.length - 1];
    if (!recoveryCommand) throw new Error("no recovery command");
    const fact = root.facts[0];
    const stringSchema = bundle.schemas.find((schema) => schema.shape.kind === "string");
    if (!fact || !stringSchema) throw new Error("history fixture schema missing");
    savePendingCommand({ run_id: "pinned-run", scope_id: "pinned-scope", command_key: recoveryCommand.key,
      owner_version: 1, targets: [], request_id: `recover-${name}`, payload: {} });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/definitions")) return cursorPage([{ bundle_id: name, digest: name, source: bundle }]);
      if (url.endsWith("/runs/pinned-run/definition")) return Response.json({ bundle_id: name, digest: name, source: bundle });
      if (url.endsWith("/runs/pinned-run/scopes/pinned-scope/history")) return Response.json({ scope_id: "pinned-scope",
        transitions: [{ id: "transition", trigger_id: "trigger", version: 1, created_at: "2026-01-01T00:00:00Z", decision: { kind: "apply" } }],
        facts: [{ id: "fact", fact_key: fact.key, payload: { schema: stringSchema.key, data: { kind: "string", value: "observed" } } }] });
      if (url.endsWith("/runs/pinned-run/scopes/pinned-scope/commands") && init?.method === "POST")
        return Response.json({ kind: "accepted_pending", request_id: `recover-${name}`, transition_id: "transition", scope_version: 2 }, { status: 202 });
      if (url.endsWith("/runs/pinned-run/scopes/pinned-scope")) return Response.json({
        run_id: "pinned-run", scope_id: "pinned-scope", label: root.presentation.label,
        state: { schema: stringSchema.key, data: { kind: "string", value: "observed" } }, outcome: null,
        outputs: [], executions: [], commands: root.commands, cursor: { scope_version: 1, transition_id: null },
        command_targets: Object.fromEntries(root.commands.map((command) => [command.key, []])), command_prefill: {},
      });
      if (url.endsWith("/runs/pinned-run")) return Response.json({ run_id: "pinned-run", scopes: [{ scope_id: "pinned-scope", scope_key: root.key, label: root.presentation.label }] });
      throw new Error(url);
    });
    vi.stubGlobal("fetch", fetch);
    renderWithQuery(<><OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />
      <GenericOperatorRunView runId="pinned-run" initialScopeId={null} onBack={() => undefined} /></>);
    const lastField = inputShape.fields[inputShape.fields.length - 1];
    if (!lastField) throw new Error("root input has no fields");
    expect(await screen.findByLabelText(new RegExp(`^${lastField.key}`))).toBeTruthy();
    expect(await screen.findByRole("heading", { name: root.presentation.label })).toBeTruthy();
    for (const command of root.commands) expect(screen.getByRole("option", { name: command.label })).toBeTruthy();
    expect(await screen.findByText(fact.key)).toBeTruthy();
    expect(await screen.findByText(`Receipt recovered for ${recoveryCommand.key}.`)).toBeTruthy();
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("/commands") && init?.method === "POST")).toHaveLength(1);
  },
);

test("launches a run using the pinned digest and entered root input", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/oakridge/api/api/definitions") return cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: { key: "demo", version: 1 } }]);
    if (url === "/oakridge/api/runs" && init?.method === "POST") return Response.json({ run_id: "run-1" }, { status: 201 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const onCreated = vi.fn();
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo v1/);
  fireEvent.change(screen.getByLabelText("Root input JSON"), { target: { value: '{"request":"hello"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ digest: "sha-1", input: { request: "hello" }, request_id: expect.any(String) });
});

test("history shows transitions and facts without exposing execution secrets", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ scope_id: "scope-1",
    transitions: [{ id: "transition-1", trigger_id: "trigger-1", version: 2, created_at: "2026-01-01T00:00:00Z", decision: { kind: "apply", publication_secret: "hidden" } }],
    facts: [{ id: "fact-1", fact_key: "reviewed", payload: { schema: "text", data: { kind: "string", value: "approved" } } }] })));
  renderWithQuery(<OperatorHistoryPane runId="run-1" scopeId="scope-1" schemas={[]} />);
  expect(await screen.findByText(/Version 2 · apply/)).toBeTruthy();
  expect(screen.getByText("reviewed")).toBeTruthy();
  expect(screen.getByText("approved")).toBeTruthy();
  expect(screen.queryByText("hidden")).toBeNull();
});


test("clone editing and pinning wait for the requested bundle, then preserve edits on refresh", async () => {
  let resolveCatalog: (response: Response) => void = () => { throw new Error("catalog not requested"); };
  const catalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
  const fetch = vi.fn(() => catalog);
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OperatorDefinitionEditorView cloneFromId="bundle-1"
    onBack={() => undefined} onPinned={() => undefined} /></QueryClientProvider>);
  const editor = screen.getByLabelText<HTMLTextAreaElement>("Source bundle");
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Pin definition" });
  expect({ editable: !editor.disabled, canPin: !submit.disabled, source: editor.value }).toEqual({ editable: false, canPin: false, source: "" });
  fireEvent.submit(submit.closest("form") as HTMLFormElement);
  expect(fetch).toHaveBeenCalledTimes(1);
  resolveCatalog(cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: { ...canonicalDefinition, version: 7 } }]));
  await waitFor(() => expect({ editable: !editor.disabled, canPin: !submit.disabled, version: JSON.parse(editor.value).version })
    .toEqual({ editable: true, canPin: true, version: 8 }));
  fireEvent.change(editor, { target: { value: "my edits" } });
  fetch.mockResolvedValue(cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: canonicalDefinition }]));
  await client.invalidateQueries({ queryKey: ["operator", "definitions"] });
  expect(editor.value).toBe("my edits");
});

test("leaving a clone for a new definition empties the editor", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: canonicalDefinition }])));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const editorAt = (cloneFromId: string | null) => <QueryClientProvider client={client}>
    <OperatorDefinitionEditorView cloneFromId={cloneFromId} onBack={() => undefined} onPinned={() => undefined} /></QueryClientProvider>;
  const { rerender } = render(editorAt("bundle-1"));
  const editor = screen.getByLabelText<HTMLTextAreaElement>("Source bundle");
  await waitFor(() => expect(editor.value).not.toBe(""));
  rerender(editorAt(null));
  await waitFor(() => expect(editor.value).toBe(""));
});

test.each([
  { name: "failed", response: () => Response.json({ error: "catalog unavailable" }, { status: 503 }), message: /Could not load definition/ },
  { name: "missing", response: () => cursorPage([]), message: /Definition not found: missing-bundle/ },
])("a $name clone lookup reports the error and keeps editing and pinning blocked", async ({ response, message }) => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId="missing-bundle" onBack={() => undefined} onPinned={() => undefined} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(message));
  expect({ editable: !screen.getByLabelText<HTMLTextAreaElement>("Source bundle").disabled,
    canPin: !screen.getByRole<HTMLButtonElement>("button", { name: "Pin definition" }).disabled }).toEqual({ editable: false, canPin: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});


test.each([503, 408, 429])("a %s launch response retains the original request for retry", async (status) => {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/definitions")) return cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: { key: "demo", version: 1 } }]);
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1 ? Response.json({ error: "uncertain" }, { status }) : Response.json({ run_id: "run-1" }, { status: 201 });
  }));
  const onCreated = vi.fn();
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo v1/);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await screen.findByText(/Launch delivery is uncertain/);
  fireEvent.click(screen.getByRole("button", { name: "Retry launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(requests[1]).toEqual(requests[0]);
});

test("a rejected launch unlocks the form for a corrected input", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/definitions")
    ? cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: { key: "demo", version: 1 } }])
    : Response.json({ error: "invalid root input" }, { status: 422 })));
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByText(/demo v1/);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await screen.findByText(/invalid root input/);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Root input JSON").disabled).toBe(false);
  expect(localStorage.getItem("oakridge:operator:pending-launch")).toBeNull();
});

test("launch is not sent when its request identity cannot be persisted", async () => {
  const fetch = vi.fn(async () => cursorPage([{ bundle_id: "bundle-1", digest: "sha-1", source: { key: "demo", version: 1 } }]));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByText(/demo v1/);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await screen.findByText(/storage unavailable/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("switching run routes resets the selected scope before fetching the new run", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    if (url === "/oakridge/config") return Response.json({ available: true });
    const match = url.match(/\/runs\/(run-[12])(?:\/(.*))?$/);
    if (!match) throw new Error(`Unexpected request: ${url}`);
    const [, runId, suffix] = match;
    const root = `${runId}-root`;
    const child = `${runId}-child`;
    if (!suffix) return Response.json({ run_id: runId, scopes: [child, root].map((scope_id) => ({ scope_id, scope_key: scope_id === root ? "root" : "child", label: scope_id })) });
    if (suffix === "definition") return Response.json({ source: { root: "root", schemas: [] } });
    if (suffix.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
    const scope_id = suffix.slice("scopes/".length);
    return Response.json({ scope_id, run_id: runId, label: scope_id,
      state: { schema: "text", data: { kind: "string", value: "ready" } },
      outcome: null, outputs: [], executions: [], commands: [], cursor: { scope_version: 1 } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (id: string) => <QueryClientProvider client={client}><OakridgeShell route={{ sub: "run", id, scope_id: null }} /></QueryClientProvider>;
  const { rerender } = render(view("run-1"));
  await screen.findByRole("heading", { name: "run-1-root" });
  fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "run-1-child" } });
  await screen.findByRole("heading", { name: "run-1-child" });
  rerender(view("run-2"));
  await screen.findByRole("heading", { name: "run-2-root" });
  expect(requests.some((url) => url.includes("/runs/run-2/scopes/run-1-"))).toBe(false);
});

test("a required root string that admits an empty value launches without ever being entered", async () => {
  const bundle = shippedBundle("development") as WorkflowDefinitionDescriptor;
  const admitsEmpty = requiredEmptyStringField(bundle);
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText(admitsEmpty.label);
  enterRootFieldsExcept(sampleRootFields(bundle), admitsEmpty.key);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input[admitsEmpty.key]).toBe("");
});

test("clearing a required root string that admits an empty value submits the empty string", async () => {
  const bundle = shippedBundle("development") as WorkflowDefinitionDescriptor;
  const admitsEmpty = requiredEmptyStringField(bundle);
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText(admitsEmpty.label);
  enterRootFieldsExcept(sampleRootFields(bundle), admitsEmpty.key);
  fireEvent.change(screen.getByLabelText(admitsEmpty.label), { target: { value: admitsEmpty.draft } });
  fireEvent.change(screen.getByLabelText(admitsEmpty.label), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input[admitsEmpty.key]).toBe("");
});

test("a required root string that admits an empty value is not marked required in the browser", async () => {
  const bundle = shippedBundle("development") as WorkflowDefinitionDescriptor;
  const admitsEmpty = requiredEmptyStringField(bundle);
  vi.stubGlobal("fetch", launchFetch(bundle));
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  expect(await screen.findByLabelText<HTMLInputElement>(admitsEmpty.label)).toHaveProperty("required", false);
});

function renderWithClient(cache: QueryClient, ui: React.ReactElement) {
  return render(<QueryClientProvider client={cache}>{ui}</QueryClientProvider>);
}
const invalidatedKeys = (cache: QueryClient) => vi.spyOn(cache, "invalidateQueries");
const expectInvalidated = (spy: ReturnType<typeof invalidatedKeys>, ...keys: readonly (readonly string[])[]) => {
  for (const queryKey of keys) expect(spy).toHaveBeenCalledWith({ queryKey });
};

test("pinning a definition refreshes the definition catalog", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ bundle_id: "b", digest: "d" }, { status: 201 }) : cursorPage([])));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = invalidatedKeys(cache);
  const onPinned = vi.fn();
  renderWithClient(cache, <OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={onPinned} />);
  fireEvent.change(screen.getByLabelText("Source bundle"), { target: { value: JSON.stringify(canonicalDefinition) } });
  fireEvent.click(screen.getByRole("button", { name: "Pin definition" }));
  await waitFor(() => expect(onPinned).toHaveBeenCalledOnce());
  expectInvalidated(spy, ["operator", "definitions"]);
});

test("launching a run refreshes the run list and the inbox", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ run_id: "run-1" }, { status: 201 })
    : cursorPage([{ bundle_id: "b", digest: "sha-1", source: { key: "demo", version: 1 } }])));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = invalidatedKeys(cache);
  const onCreated = vi.fn();
  renderWithClient(cache, <OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo v1/);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expectInvalidated(spy, ["operator", "runs"], ["operator", "inbox"]);
});

test("an accepted command refreshes the run, the run list and the inbox", async () => {
  const command = { key: "act", label: "Act", consequence: "Go", payload_schema: "empty", field_presentation: [], targets: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/commands") && init?.method === "POST")
      return Response.json({ kind: "accepted_pending", request_id: "r", transition_id: "t", scope_version: 2 }, { status: 202 });
    if (url.endsWith("/runs/run-1")) return Response.json({ run_id: "run-1", scopes: [{ scope_id: "s", scope_key: "root", label: "Root" }] });
    if (url.endsWith("/definition")) return Response.json({ source: { root: "root", schemas: [{ key: "empty", shape: { kind: "record", fields: [], dictionary: null } }] } });
    if (url.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
    return Response.json({ scope_id: "s", run_id: "run-1", label: "Root", state: { schema: "empty", data: { kind: "string", value: "x" } },
      outcome: null, outputs: [], executions: [], commands: [command], command_targets: { act: [] }, command_prefill: {}, cursor: { scope_version: 1 } });
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = invalidatedKeys(cache);
  renderWithClient(cache, <GenericOperatorRunView runId="run-1" initialScopeId={null} onBack={() => undefined} />);
  fireEvent.click(await screen.findByRole("button", { name: "Submit Act" }));
  await screen.findByText("Command accepted.");
  expectInvalidated(spy, ["operator", "run-1"], ["operator", "runs"], ["operator", "inbox"]);
});
