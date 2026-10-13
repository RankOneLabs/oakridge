import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { Hono } from "hono";
import { installDefinitionApi } from "../../../oakridge-dbos/src/http/app";
import type { DecideRequest } from "../../../oakridge-dbos/src/http/ingress";
import { actionOf, executor, launch, openAuthority, pinSample, submitter, unitOf } from "../../../oakridge-dbos/tests/authority-fixture";

async function browserScript(): Promise<string> {
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "operator-browser-entry.tsx")], target: "browser",
    plugins: [{ name: "single-react", setup(build) {
      build.onResolve({ filter: /^(react|react-dom|@tanstack\/react-query)(\/|$)/ }, (args) =>
        ({ path: Bun.resolveSync(args.path, resolve(import.meta.dir, "../..")) }));
    } }],
  });
  if (!built.success) throw new AggregateError(built.logs, "Browser fixture build failed");
  return built.outputs[0]!.text();
}

let browser: Browser;
let script: string;
beforeAll(async () => {
  script = await browserScript();
  // CI installs the Chromium version paired with Playwright; use that browser.
  // Cold startup has its own budget so each scenario keeps its 30-second limit.
  browser = await chromium.launch({ args: ["--no-sandbox"] });
}, 60_000);
afterAll(async () => { await browser?.close(); });

// Real Chromium, the production React surface, and the authority's own HTTP
// API over a real core and a scratch Postgres database.
test("browser submits a decision on its target revision and recovers a lost receipt after reload", async () => {
  const authority = await openAuthority();
  const { bundle_id } = await pinSample(authority);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  const unit = unitOf(run_id, "document");
  const writer = await actionOf(authority, run_id, "writer");
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_started", action: writer, kbbl_session_id: "sid-writer" }, writer: executor(writer) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "first" }, by: writer }, writer: executor(writer) });
  const api = new Hono();
  installDefinitionApi(api, { db: authority.db, core: authority.core, wake: () => undefined, is_operator_request: () => true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname.startsWith("/oakridge/api/")) {
      url.pathname = url.pathname.slice("/oakridge/api".length);
      return api.fetch(new Request(url, request));
    }
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const requests: DecideRequest[] = [];
    const receipts: unknown[] = [];
    await page.route("**/reviews/editor/decide", async (route) => {
      requests.push(route.request().postDataJSON() as DecideRequest);
      const response = await route.fetch();
      receipts.push(await response.json());
      if (requests.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page.goto(`${server.url.href}?run=${encodeURIComponent(run_id)}&unit=${encodeURIComponent(unit)}`);
    const change = page.getByTestId("operator-command-form").filter({ has: page.getByRole("button", { name: "Submit Request changes", exact: true }) });
    await change.waitFor();
    await change.getByRole("textbox").fill("Change draft");
    await change.getByRole("button", { name: "Submit Request changes", exact: true }).click();
    await change.getByRole("alert").filter({ hasText: "Delivery is uncertain." }).waitFor();
    expect(requests[0]).toMatchObject({ decision: "request_changes", target: `${unit}:draft:1`, payload: { feedback: "Change draft" } });
    await page.reload();
    await page.getByText("Receipt recovered for request_changes.", { exact: true }).waitFor();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(receipts[1]).toEqual(receipts[0]);
    const events = await authority.db.selectFrom("authority.event").select("payload").where("run_id", "=", run_id).execute();
    expect(events.filter((event) => event.payload.kind === "operator_decided")).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("oakridge:operator:pending:")))).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); await authority.close(); }
}, 30_000);

test("browser recovers a committed launch after losing its response and reloading", async () => {
  const requests: Array<{ readonly request_id: string; readonly digest: string; readonly input: unknown }> = [];
  let launches = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname === "/oakridge/api/api/definitions") return Response.json({ items: [{ bundle_id: "bundle-1", digest: "sha-1", archived_at: null,
      bundle: { key: "demo", version: 1, root: "$root", schemas: [], units: [{ key: "$root", stage: null, label: "Demo", input_schema: "{request: text}", artifacts: [] }] } }],
      next_cursor: null });
    if (url.pathname === "/oakridge/api/api/runs") {
      const input = await request.json() as typeof requests[number];
      if (!requests.some((previous) => previous.request_id === input.request_id)) launches++;
      requests.push(input);
      return Response.json({ kind: "committed", run_id: "run-1", event_id: "event-1" }, { status: 201 });
    }
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/oakridge/api/api/runs", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      if (requests.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page.goto(`${server.url.href}?launch`);
    await page.getByRole("option", { name: /demo v1/ }).waitFor({ state: "attached" });
    await page.getByLabel("Root input JSON").fill('{"request":"hello"}');
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Launch delivery is uncertain." }).waitFor();
    expect(launches).toBe(1);
    expect(await page.getByLabel("Root input JSON").isDisabled()).toBe(true);
    await page.reload();
    const retry = page.getByRole("button", { name: "Retry launch", exact: true });
    await retry.waitFor();
    expect(JSON.parse(await page.getByLabel("Root input JSON").inputValue())).toEqual({ request: "hello" });
    expect(await page.getByLabel("Definition digest").isDisabled()).toBe(true);
    await retry.click();
    await page.waitForURL("**#run/run-1");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(launches).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("oakridge:operator:pending-launch"))).toBeNull();
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);
