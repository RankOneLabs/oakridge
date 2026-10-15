import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";

async function browserScript(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "oakridge-v1-browser-"));
  const output = join(directory, "entry.js");
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, "build", resolve(import.meta.dir, "operator-browser-entry.tsx"),
      "--target=browser", `--outfile=${output}`], cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`Browser fixture build failed: ${result.stderr.toString()}`);
    return readFileSync(output, "utf8");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const pageHtml = '<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>';
const json = (body: unknown): Response => Response.json(body);

let browser: Browser;
let script: string;
beforeAll(async () => {
  script = await browserScript();
  browser = await chromium.launch({ args: ["--no-sandbox"] });
}, 60_000);
afterAll(async () => { await browser?.close(); });

// The restored v1 forms call the legacy API surface. These browser fixtures
// exercise the UI contract while the later data-layer cohort ports those calls.
test("browser starts a v1 workflow run from the restored launch form", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname === "/oakridge/config") return json({ available: true, core_url: "http://127.0.0.1:8790" });
    if (url.pathname === "/config") return json({ defaultWorkdir: "/repo", defaultRuntimeId: "claude-code",
      runtimes: [{ id: "claude-code", label: "Claude Code", models: [{ value: "opus", label: "Opus" }], efforts: [], supportsCompaction: true }] });
    if (url.pathname === "/oakridge/api/projects") return json([]);
    if (url.pathname === "/oakridge/api/workflow_defs") return json([{ id: "def-1", name: "development", version: 1 }]);
    if (url.pathname === "/oakridge/api/workflow_runs" && request.method === "POST") {
      requests.push(await request.json());
      return json({ id: "run-1" });
    }
    return new Response(pageHtml, { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto(`${server.url.href}?launch`);
    await page.getByTestId("or-new-run-form").waitFor();
    await page.getByRole("option", { name: "development v1" }).waitFor({ state: "attached" });
    await page.getByLabel("Epic title").fill("Ship the v1 UI");
    await page.getByLabel("Repository 1 GitHub owner").fill("RankOneLabs");
    await page.getByLabel("Repository 1 GitHub name").fill("oakridge");
    await page.getByLabel("Repository 1 path").fill("/repo");
    await page.getByLabel("Brief notes", { exact: true }).fill("Restore the operator UI");
    await page.getByRole("button", { name: "Start Run" }).click();
    await page.waitForURL("**#run/run-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ workflow_def_id: "def-1" });
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);

test("browser renders a v1 run workspace from its run, gate, and session reads", async () => {
  const requestedPaths: string[] = [];
  const run = { id: "run-1", title: "Ship the v1 UI", repository_keys: ["oakridge"],
    workflow_name: "development", status: "running", is_stuck: false, parked_count: 0,
    updated_at: "2026-10-09T00:00:00Z", stages: [] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname.startsWith("/oakridge/api/")) {
      requestedPaths.push(url.pathname);
      if (url.pathname === "/oakridge/api/runs/run-1") return json(run);
      return json([]);
    }
    return new Response(pageHtml, { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto(`${server.url.href}?run=run-1`);
    await page.getByTestId("or-run-identity-title").getByText("Ship the v1 UI").waitFor();
    await page.getByTestId("or-run-overview").waitFor();
    expect(requestedPaths).toContain("/oakridge/api/runs/run-1");
    expect(requestedPaths).toContain("/oakridge/api/runs/run-1/gates");
    expect(requestedPaths).toContain("/oakridge/api/runs/run-1/sessions");
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);
