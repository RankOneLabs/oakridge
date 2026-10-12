import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";

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

// Real Chromium and the production React surface, against a mocked API. The
// scope-command scenario drove the v1 command route and fixture that rescue R1
// deletes; R6 restores it against the v2 decide route when it ports the PWA.
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
