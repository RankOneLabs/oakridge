import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { OperatorLaunchView } from "../views/OperatorLaunchView";
import { OperatorHistoryPane } from "../views/OperatorHistoryPane";
import { OperatorDefinitionEditorView } from "../views/OperatorDefinitionEditorView";
import type { OperatorDefinitionBundle } from "../operator-contracts";
import { makeCompiledWorkflow, makeDevelopmentBundle, makeWorkflowSource } from "../__fixtures__/read-models";
import { formatWorkflowText } from "../lib/workflow-definition-form";

/** The development bundle with one more root input field, which the form can only take as JSON. */
function extendedBundle(): OperatorDefinitionBundle {
  const source = makeDevelopmentBundle();
  const root = source.units.find((unit) => unit.key === source.root);
  const input = source.schemas.find((schema) => schema.key === root?.input_schema);
  if (!root || input?.shape.kind !== "record") throw new Error("Invalid development bundle");
  return { ...source, key: "development-verification", schemas: [...source.schemas, { key: "test_extended_root", shape: { ...input.shape,
    fields: [...input.shape.fields, { key: "verification_notes", schema: "list(text)" }] } }],
    units: source.units.map((unit) => unit.key === root.key ? { ...unit, input_schema: "test_extended_root" } : unit) };
}

/** Field kinds the launch form renders as a plain control; every other kind gets a JSON entry. */
const DIRECT_ENTRY_KINDS: readonly string[] = ["string", "integer", "boolean", "enum"];

function sampleSchemaValue(bundle: OperatorDefinitionBundle, key: string): unknown {
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
  return Object.fromEntries(shape.fields.map((field) => [field.key, sampleSchemaValue(bundle, field.schema)]));
}

interface SampledRootField { readonly key: string; readonly label: string; readonly draft: string; readonly value: unknown }

/** Every root input field a bundle declares, with the label and entry text the form expects for it. */
function sampleRootFields(bundle: OperatorDefinitionBundle): readonly SampledRootField[] {
  const root = bundle.units.find((unit) => unit.key === bundle.root);
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

/** The root text field whose schema admits "", so a blank entry is a value the authority accepts rather than a missing input. */
function emptyAdmittingStringField(bundle: OperatorDefinitionBundle): SampledRootField {
  const root = bundle.units.find((unit) => unit.key === bundle.root);
  const shape = bundle.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
  if (shape?.kind !== "record") throw new Error("root input is not a record");
  const declared = shape.fields.find((field) => {
    const fieldShape = bundle.schemas.find((schema) => schema.key === field.schema)?.shape;
    return fieldShape?.kind === "string" && fieldShape.min_length === 0;
  });
  if (!declared) throw new Error("no root string admits an empty value");
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
const committed = (run_id: string): Response => Response.json({ kind: "committed", run_id, event_id: "event-1" }, { status: 201 });
/** A pinned definition whose root input is untyped here, so the launch form offers raw JSON. */
const demo = (digest = "sha-1", key = "demo") => ({ bundle_id: `bundle-${digest}`, digest, archived_at: null, bundle: { key, root: "$root",
  schemas: [], units: [{ key: "$root", stage: null, label: "Demo", input_schema: "{request: text}", artifacts: [] }] } });
const isLaunch = (url: string, init?: RequestInit): boolean => url === "/oakridge/api/api/runs" && init?.method === "POST";

/** Serves one pinned bundle and accepts the launch it produces. */
const launchFetch = (bundle: OperatorDefinitionBundle) => vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/config") return Response.json({ defaultWorkdir: null, defaultRuntimeId: "claude-code", runtimes: [] });
  if (url.endsWith("/definitions")) return cursorPage([{ bundle_id: "pinned", digest: "pinned-digest", bundle }]);
  if (isLaunch(url, init)) return committed("new-run");
  throw new Error(url);
});
const postedLaunch = (fetch: ReturnType<typeof launchFetch>) => {
  const call = fetch.mock.calls.find(([url, init]) => isLaunch(url, init));
  return call ? JSON.parse(String(call[1]?.body)) : null;
};

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

test("with several pinned definitions the operator must choose one before launching", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/definitions")) return cursorPage([demo("sha-1", "alpha"), demo("sha-2", "beta")]);
    if (isLaunch(url, init)) return committed("run-1");
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByText(/beta · /);
  expect(screen.getByLabelText<HTMLSelectElement>("Definition digest").value).toBe("");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Launch" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Definition digest"), { target: { value: "sha-2" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Launch" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).digest).toBe("sha-2");
});

test("an extra structured root input renders as JSON and round-trips the raw editor", async () => {
  const bundle = extendedBundle();
  const fields = sampleRootFields(bundle);
  const extra = fields[fields.length - 1];
  if (!extra) throw new Error("root input has no fields");
  if (!extra.label.endsWith(" JSON")) throw new Error(`${extra.key} no longer needs a JSON fallback`);
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText(extra.label);
  for (const field of fields) fireEvent.change(screen.getByLabelText(field.label), { target: { value: field.draft } });
  fireEvent.click(screen.getByLabelText("Raw JSON"));
  expect(JSON.parse(screen.getByLabelText<HTMLTextAreaElement>("Root input JSON").value)).toEqual(rootInputRecord(fields));
  fireEvent.click(screen.getByLabelText("Raw JSON"));
  expect(JSON.parse(screen.getByLabelText<HTMLTextAreaElement>(extra.label).value)).toEqual(extra.value);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(postedLaunch(fetch)).not.toBeNull());
  expect(postedLaunch(fetch).input).toEqual(rootInputRecord(fields));
});

test("the development launch sends every root field the operator entered", async () => {
  const bundle = makeDevelopmentBundle();
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText("spec");
  for (const field of sampleRootFields(bundle)) fireEvent.change(screen.getByLabelText(field.label), { target: { value: field.draft } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(postedLaunch(fetch)).not.toBeNull());
  expect(postedLaunch(fetch).input).toEqual(rootInputRecord(sampleRootFields(bundle)));
});

test("the development launch carries the planner and worker settings as each stage's session settings", async () => {
  const bundle = makeDevelopmentBundle();
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByTestId("or-role-settings");
  for (const field of sampleRootFields(bundle)) fireEvent.change(screen.getByLabelText(field.label), { target: { value: field.draft } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(postedLaunch(fetch)).not.toBeNull());
  const sessions = postedLaunch(fetch).config.sessions as { readonly [stage: string]: { readonly harness: string } };
  expect(Object.keys(sessions).sort()).toEqual([...new Set(bundle.units.flatMap((unit) => unit.stage ?? []))].sort());
});

test("launches a run using the pinned digest and entered root input", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/oakridge/api/api/definitions") return cursorPage([demo()]);
    if (isLaunch(url, init)) return committed("run-1");
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const onCreated = vi.fn();
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo · /);
  fireEvent.change(screen.getByLabelText("Root input JSON"), { target: { value: '{"request":"hello"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ digest: "sha-1", input: { request: "hello" }, project_id: null, request_id: expect.any(String) });
});

test("history shows each event with its writer, without exposing secrets", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ unit_id: "unit-1", next_cursor: null,
    events: [{ id: "event-1", ingress_id: "ingress-1", created_at: "2026-01-01T00:00:00Z", writer: { kind: "operator", subject: "operator" },
      event: { kind: "retry_requested", unit: "unit-1", worker: "writer", publication_secret: "hidden" } }] })));
  renderWithQuery(<OperatorHistoryPane runId="run-1" unitId="unit-1" />);
  expect(await screen.findByText(/retry_requested · operator · ingress-1/)).toBeTruthy();
  expect(screen.queryByText("hidden")).toBeNull();
});

test.each([503, 408, 429])("a %s launch response retains the original request for retry", async (status) => {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/definitions")) return cursorPage([demo()]);
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1 ? Response.json({ error: "uncertain" }, { status }) : committed("run-1");
  }));
  const onCreated = vi.fn();
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo · /);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await screen.findByText(/Launch delivery is uncertain/);
  fireEvent.click(screen.getByRole("button", { name: "Retry launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(requests[1]).toEqual(requests[0]);
});

test("a rejected launch unlocks the form for a corrected input", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/definitions")
    ? cursorPage([demo()])
    : Response.json({ error: "invalid root input" }, { status: 422 })));
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByText(/demo · /);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await screen.findByText(/invalid root input/);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Root input JSON").disabled).toBe(false);
  expect(localStorage.getItem("oakridge:operator:pending-launch")).toBeNull();
});

test("launch is not sent when its request identity cannot be persisted", async () => {
  const fetch = vi.fn(async () => cursorPage([demo()]));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByText(/demo · /);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await screen.findByText(/storage unavailable/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a root string that admits an empty value launches without ever being entered", async () => {
  const bundle = makeDevelopmentBundle();
  const admitsEmpty = emptyAdmittingStringField(bundle);
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText(admitsEmpty.label);
  enterRootFieldsExcept(sampleRootFields(bundle), admitsEmpty.key);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(postedLaunch(fetch)).not.toBeNull());
  expect(postedLaunch(fetch).input[admitsEmpty.key]).toBe("");
});

test("clearing a root string that admits an empty value submits the empty string", async () => {
  const bundle = makeDevelopmentBundle();
  const admitsEmpty = emptyAdmittingStringField(bundle);
  const fetch = launchFetch(bundle);
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={() => undefined} onEdit={() => undefined} />);
  await screen.findByLabelText(admitsEmpty.label);
  enterRootFieldsExcept(sampleRootFields(bundle), admitsEmpty.key);
  fireEvent.change(screen.getByLabelText(admitsEmpty.label), { target: { value: admitsEmpty.draft } });
  fireEvent.change(screen.getByLabelText(admitsEmpty.label), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(postedLaunch(fetch)).not.toBeNull());
  expect(postedLaunch(fetch).input[admitsEmpty.key]).toBe("");
});

test("a root string that admits an empty value is not marked required in the browser", async () => {
  const bundle = makeDevelopmentBundle();
  const admitsEmpty = emptyAdmittingStringField(bundle);
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

test("launching a run refreshes the run list and the inbox", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? committed("run-1") : cursorPage([demo()])));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = invalidatedKeys(cache);
  const onCreated = vi.fn();
  renderWithClient(cache, <OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo · /);
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expectInvalidated(spy, ["operator", "runs"], ["operator", "inbox"]);
});

const enterWorkflow = (text = formatWorkflowText(makeWorkflowSource())) =>
  fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: text } });

test("the editor compiles the workflow before pinning exactly what compiled", async () => {
  const requests: { readonly path: string; readonly body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ path: url, body: JSON.parse(String(init?.body)) });
    return url.endsWith("/compile") ? Response.json(makeCompiledWorkflow({ digest: "compiled" }))
      : Response.json({ bundle_id: "bundle-1", digest: "compiled" }, { status: 201 });
  }));
  const onPinned = vi.fn();
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={onPinned} />);
  enterWorkflow();
  fireEvent.click(screen.getByRole("button", { name: "Compile definition" }));
  await screen.findByText(/Compiled successfully/);
  expect(requests.map((request) => request.path)).toEqual(["/oakridge/api/api/definitions/compile"]);
  fireEvent.click(screen.getByRole("button", { name: "Pin definition" }));
  await waitFor(() => expect(onPinned).toHaveBeenCalledOnce());
  expect(requests.map((request) => request.path)).toEqual([
    "/oakridge/api/api/definitions/compile", "/oakridge/api/api/definitions",
  ]);
  expect(requests[1]?.body).toEqual(requests[0]?.body);
});

test("a failed compile leaves pinning unavailable", async () => {
  const fetch = vi.fn(async () => Response.json({ error: "unknown prompt write.md" }, { status: 422 }));
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={() => undefined} />);
  enterWorkflow();
  fireEvent.click(screen.getByRole("button", { name: "Compile definition" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/unknown prompt write\.md/);
  expect(screen.queryByRole("button", { name: "Pin definition" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("editing while compilation is in flight requires another compile", async () => {
  let finish: (response: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => response));
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={() => undefined} />);
  enterWorkflow();
  fireEvent.click(screen.getByRole("button", { name: "Compile definition" }));
  enterWorkflow(formatWorkflowText(makeWorkflowSource({ workflow: "changed" })));
  finish(Response.json({ digest: "old-text", stages: [] }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Compile definition" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Pin definition" })).toBeNull();
});
