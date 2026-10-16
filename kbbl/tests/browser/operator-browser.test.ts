import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import capturedRun from "../../core/pwa/oakridge/__fixtures__/v2-adapter-sample.json";
import definitionFixture from "../../core/pwa/oakridge/__fixtures__/v2-definition-detail.json";

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

const runId = capturedRun.run.run_id;
const definition = { bundle_id: capturedRun.run.definition_bundle_id, digest: capturedRun.run.definition_digest,
  bundle: { key: "development" }, archived_at: null };
const v2Read = (path: string): Response | null => {
  if (path === "/oakridge/api/api/projects") return json({ items: [] });
  if (path === "/oakridge/api/api/definitions") return json({ items: [definition], next_cursor: null });
  if (path === `/oakridge/api/api/definitions/${definition.bundle_id}`) return json({ ...definitionFixture.definition, ...definition });
  if (path === `/oakridge/api/api/runs/${runId}`) return json(capturedRun.run);
  if (path === `/oakridge/api/api/runs/${runId}/units`) return json(capturedRun.units);
  if (path === "/oakridge/api/run_events") return json([]);
  return null;
};

// Keep the browser's HTTP fixture on the same v2 contract as the client.
test("browser starts a v2 workflow run from the frozen v1 launch form", async () => {
  const launches: unknown[] = [];
  const requestedPaths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname === "/oakridge/config") return json({ available: true, core_url: "http://127.0.0.1:8790" });
    if (url.pathname === "/config") return json({ defaultWorkdir: "/repo", defaultRuntimeId: "claude-code",
      runtimes: [{ id: "claude-code", label: "Claude Code", models: [{ value: "opus", label: "Opus" },
        { value: "sonnet", label: "Sonnet" }], efforts: [], supportsCompaction: true }] });
    if (url.pathname.startsWith("/oakridge/api/")) requestedPaths.push(url.pathname);
    if (url.pathname === "/oakridge/api/api/runs" && request.method === "POST") {
      launches.push(await request.json());
      return json({ kind: "committed", run_id: runId, event_id: "launch-event" });
    }
    const read = v2Read(url.pathname);
    if (read) return read;
    if (url.pathname.startsWith("/oakridge/api/")) return Response.json({ error: "unexpected browser API request" }, { status: 404 });
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
    await page.getByLabel("cohort · builder model").selectOption("sonnet");
    await page.getByLabel("cohort · assessor model").selectOption("opus");
    await page.getByRole("button", { name: "Start Run" }).click();
    await page.waitForURL(`**#run/${runId}`);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ digest: capturedRun.run.definition_digest,
      input: { title: "Ship the v1 UI", spec: "Restore the operator UI" },
      config: { sessions: { analysis: { author: {} }, planning: { planner: {} }, brief: { writer: {} },
        cohort: { builder: { model: "sonnet" }, assessor: { model: "opus" } }, integration: { integrator: {} } } } });
    expect(requestedPaths).toContain(`/oakridge/api/api/runs/${runId}/units`);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);

test("browser renders the frozen v1 workspace from v2 run and unit views", async () => {
  const requestedPaths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname.startsWith("/oakridge/api/")) {
      requestedPaths.push(url.pathname);
      return v2Read(url.pathname) ?? Response.json({ error: "unexpected browser API request" }, { status: 404 });
    }
    return new Response(pageHtml, { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto(`${server.url.href}?run=${runId}`);
    await page.getByTestId("or-run-identity-title").getByText("Two cohorts").waitFor();
    await page.getByTestId("or-run-overview").waitFor();
    await page.getByTestId("or-run-identity-status").getByText("parked").waitFor();
    await page.getByTestId("or-overview-gate").first().waitFor();
    expect(requestedPaths).toContain(`/oakridge/api/api/runs/${runId}`);
    expect(requestedPaths).toContain(`/oakridge/api/api/runs/${runId}/units`);
    expect(requestedPaths).not.toContain(`/oakridge/api/runs/${runId}/gates`);
    expect(requestedPaths).not.toContain(`/oakridge/api/runs/${runId}/sessions`);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);
