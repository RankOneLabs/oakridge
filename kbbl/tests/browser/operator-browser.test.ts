import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import type { ScopeCommandRequest } from "../../../oakridge-dbos/src/http/scope-commands";
import { harness } from "../../../oakridge-dbos/tests/scope-command-fixture";

// Real Chromium, the production React surface, and the installed Hono API.
// The shared fixture supplies a deterministic database/core boundary.
test("browser isolates drafts, submits observed result targets, and recovers a lost receipt after reload", async () => {
  const api = await harness({ operator_workspace: true });
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "operator-browser-entry.tsx")], target: "browser",
    plugins: [{ name: "single-react", setup(build) {
      build.onResolve({ filter: /^(react|react-dom|@tanstack\/react-query)(\/|$)/ }, (args) =>
        ({ path: Bun.resolveSync(args.path, resolve(import.meta.dir, "../..")) }));
    } }],
  });
  if (!built.success) throw new AggregateError(built.logs, "Browser fixture build failed");
  const script = await built.outputs[0]!.text();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname.startsWith("/oakridge/api/")) {
      url.pathname = url.pathname.slice("/oakridge/api".length);
      return api.app.fetch(new Request(url, request));
    }
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ ...(existsSync("/usr/bin/google-chrome") ? { executablePath: "/usr/bin/google-chrome" } : {}), args: ["--no-sandbox"] });
    const page = await browser.newPage();
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
  } finally { await browser?.close(); server.stop(true); }
}, 30_000);
