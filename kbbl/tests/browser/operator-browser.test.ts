import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import type { ScopeCommandRequest } from "../../../oakridge-dbos/src/http/scope-commands";
import { harness } from "../../../oakridge-dbos/tests/scope-command-fixture";

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

// Real Chromium, the production React surface, and the installed Hono API.
// The shared fixture supplies a deterministic database/core boundary.
test("browser isolates drafts, submits observed result targets, and recovers a lost receipt after reload", async () => {
  const api = await harness({ operator_workspace: true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname.startsWith("/oakridge/api/")) {
      url.pathname = url.pathname.slice("/oakridge/api".length);
      return api.app.fetch(new Request(url, request));
    }
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const requests: ScopeCommandRequest[] = [];
    const receipts: unknown[] = [];
    await page.route("**/scopes/scope-1/commands", async (route) => {
      requests.push(route.request().postDataJSON() as ScopeCommandRequest);
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      receipts.push(await response.json());
      if (requests.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page.goto(server.url.href);
    await page.getByText("Output artifact body", { exact: true }).waitFor();
    await page.getByTestId("operator-history-pane").getByText("No transitions yet.", { exact: true }).waitFor();
    await page.getByLabel("Feedback").fill("Discussion draft");
    await page.getByLabel("Action", { exact: true }).selectOption("change");
    expect(await page.getByLabel("Feedback").inputValue()).toBe("");
    await page.getByLabel("Action", { exact: true }).selectOption("discuss");
    expect(await page.getByLabel("Feedback").inputValue()).toBe("Discussion draft");
    await page.getByLabel("Action", { exact: true }).selectOption("change");
    await page.getByLabel("Feedback").fill("Change draft");
    await page.getByRole("button", { name: "Submit change", exact: true }).click();
    await page.getByTestId("operator-command-form").getByRole("alert")
      .filter({ hasText: "Delivery is uncertain." }).waitFor();
    expect(requests[0]).toMatchObject({ command_key: "change", expected_scope_version: 4,
      targets: [{ identity: "exec-1", version: 6 }], payload: { text: "Change draft" } });
    expect(api.evaluationCount()).toBe(1);
    await page.reload();
    await page.getByText("Receipt recovered for change.", { exact: true }).waitFor();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(receipts[1]).toEqual(receipts[0]);
    expect(api.evaluationCount()).toBe(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("oakridge:operator:pending:")))).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);


test("browser recovers a committed launch after losing its response and reloading", async () => {
  const requests: Array<{ readonly request_id: string; readonly digest: string; readonly input: unknown }> = [];
  let launches = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname === "/oakridge/api/api/definitions") return Response.json({ items: [{ bundle_id: "bundle-1", digest: "sha-1", source: { key: "demo", version: 1 } }], next_cursor: null });
    if (url.pathname === "/oakridge/api/runs") {
      const input = await request.json() as typeof requests[number];
      if (!requests.some((previous) => previous.request_id === input.request_id)) launches++;
      requests.push(input);
      return Response.json({ run_id: "run-1", root_scope_id: "scope-1", bundle_id: "bundle-1" }, { status: 201 });
    }
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/oakridge/api/runs", async (route) => {
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
