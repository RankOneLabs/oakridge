import projectedSchemas from "../../core/pwa/oakridge/__fixtures__/development-projected-schemas.json";
import { projectedReview } from "../../core/pwa/oakridge/__fixtures__/read-models";
import { currentArtifactFixture } from "./current-artifact-fixture";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import capturedRun from "../../core/pwa/oakridge/__fixtures__/v2-adapter-sample.json";
import definitionFixture from "../../core/pwa/oakridge/__fixtures__/v2-definition-detail.json";
import { selectAbbreviatedDefinitionId } from "../../core/pwa/oakridge/lib/definition-overview";
import type { OperatorUnitView } from "../../core/pwa/oakridge/operator-contracts/projections/unit-view";

async function browserScript(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "oakridge-v1-browser-"));
  const output = join(directory, "entry.js");
  // Library imports emit CSS too; keep its extension distinct from entry.js.
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, "build", resolve(import.meta.dir, "operator-browser-entry.tsx"),
      "--target=browser", `--outdir=${directory}`, "--entry-naming=entry.[ext]"], cwd: resolve(import.meta.dir, "../../.."),
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
const definition = definitionFixture.definition;
const currentArtifactDefinition = { ...definition, bundle: { ...definition.bundle, schemas: projectedSchemas } };
const artifactRun = { ...capturedRun.run, run_id: "run", definition_id: definition.definition_id };
const v2Read = (path: string): Response | null => {
  if (path === "/oakridge/api/api/projects") return json({ items: [] });
  if (path === "/oakridge/api/api/definitions") return json({ items: [definition], next_cursor: null });
  if (path === `/oakridge/api/api/definitions/${definition.definition_id}`) return json({ ...definitionFixture.definition, ...definition });
  if (path === `/oakridge/api/api/runs/${runId}`) return json(capturedRun.run);
  if (path === `/oakridge/api/api/runs/${runId}/units`) return json(capturedRun.units);
  if (path === "/oakridge/api/run_events") return json([]);
  return null;
};

// Keep the browser's HTTP fixture on the same v2 contract as the client.
test("browser starts a workflow run from the projected root input form", async () => {
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
    await page.getByRole("option", { name: "development" }).waitFor({ state: "attached" });
    await page.getByLabel("title", { exact: true }).fill("Ship the v1 UI");
    await page.getByLabel("Use repository picker").check();
    await page.getByLabel("primary repository key").fill("repo");
    await page.getByLabel("final merge policy").selectOption("require_merge");
    await page.getByLabel("Repository 1 GitHub owner").fill("RankOneLabs");
    await page.getByLabel("Repository 1 GitHub name").fill("oakridge");
    await page.getByLabel("Repository 1 path").fill("/repo");
    await page.getByLabel("spec", { exact: true }).fill("Restore the operator UI");
    await page.getByRole("button", { name: "Per session" }).click();
    await page.getByLabel("cohort · builder model").selectOption("sonnet");
    await page.getByLabel("cohort · assessor model").selectOption("opus");
    await page.getByRole("button", { name: "Start Run" }).click();
    await page.waitForURL(`**#run/${runId}`);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ definition_id: definition.definition_id,
      input: { title: "Ship the v1 UI", spec: "Restore the operator UI" },
      config: { sessions: { analysis: { author: {} }, planning: { planner: {} }, brief: { writer: {} },
        cohort: { builder: { model: "sonnet" }, assessor: { model: "opus" } }, integration: { integrator: { model: "opus" } } } } });
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

test("browser navigates the committed definition list and detail", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    return v2Read(path) ?? new Response(pageHtml, { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${server.url.href}?definitions`);
    await page.getByTestId("or-def-list").waitFor();
    await page.getByTestId("or-def-view-btn").click();
    await page.getByTestId("or-def-detail").waitFor();
    await page.getByRole("heading", { name: definition.effective_workflow.workflow, exact: true }).waitFor();
    expect(await page.locator(".or-page-summary").textContent()).toStartWith(selectAbbreviatedDefinitionId(definition.definition_id) + " · ");
    const stages = page.getByLabel("Stages in authored order");
    expect(await stages.locator("option.or-definition-navigation-stage").allTextContents()).toEqual(definition.bundle.stages);
    expect(await stages.inputValue()).toBe("");
    await page.getByText("Select a stage or unit to inspect its declaration.", { exact: true }).waitFor();
    for (const name of ["Schema", "Raw definition"]) {
      expect(await page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")).toBe("false");
      expect(await page.getByRole("region", { name, exact: true }).count()).toBe(0);
    }
    await page.getByRole("button", { name: "Schema", exact: true }).click();
    const schema = page.getByRole("region", { name: "Schema", exact: true });
    await schema.getByRole("heading", { name: "Schemas", exact: true }).waitFor();
    expect(await schema.getByRole("heading", { name: "Root input", exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Schema", exact: true }).click();
    expect(await schema.count()).toBe(0);

    const graph = page.getByRole("region", { name: "Definition dependencies" });
    await graph.getByRole("link", { name: "implementation", exact: true }).first().click();
    await page.getByRole("heading", { name: "cohort · unit implementation", exact: true }).waitFor();
    expect(new URL(page.url()).hash).toBe(`#settings/workflows/${definition.definition_id}/units/implementation`);
    const graphHandle = await graph.elementHandle();
    const breadcrumbs = await graph.getByRole("navigation", { name: "Graph level" }).textContent();
    await page.getByRole("tab", { name: "Workers", exact: true }).click();
    const workers = page.getByRole("tabpanel", { name: "Workers", exact: true });
    await workers.waitFor();
    expect(new URL(page.url()).hash).toBe(`#settings/workflows/${definition.definition_id}/tabs/workers/units/implementation`);
    expect(await graphHandle?.evaluate(element => element.isConnected)).toBe(true);
    expect(await graph.getByRole("navigation", { name: "Graph level" }).textContent()).toBe(breadcrumbs);
    await workers.getByRole("link", { name: "build_result", exact: true }).first().click();
    await page.getByRole("tabpanel", { name: "Artifacts", exact: true }).waitFor();
    expect(new URL(page.url()).hash).toBe(`#settings/workflows/${definition.definition_id}/units/implementation#stage-cohort-artifact-build_result`);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("stage-cohort-artifact-build_result");
    await page.getByRole("button", { name: "Raw definition", exact: true }).click();
    await page.getByRole("tabpanel", { name: "Authored", exact: true }).waitFor();
    await page.getByRole("button", { name: "← Workflows" }).click();
    await page.getByTestId("or-def-list").waitFor();
  } finally { await context.close(); server.stop(true); }
}, 30_000);

test.each([
  // Each viewer opens on its first section: analysis requirements, spec requirements, the plan graph, build items, item assessments.
  ["analysis", "Observation F1"], ["spec", "Canonical workflow"], ["plan", "Cohort A"], ["brief", "Implement requirements"], ["assessment", "The requested behavior works."],
] as const)("live-version %s revisions reach their current viewer through the real client", async (kind, expected) => {
  const fixture = currentArtifactFixture(kind);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (path === "/oakridge/api/api/runs/run") return json(artifactRun);
    if (path.startsWith("/oakridge/api/api/definitions/")) return json(currentArtifactDefinition);
    if (path === "/oakridge/api/api/runs/run/units") return Response.json([fixture.unit]);
    if (path === `/oakridge/api/api/runs/run/units/${encodeURIComponent(fixture.unit.unit_id)}/artifacts/${kind}`) return Response.json(fixture.detail);
    if (path.startsWith("/oakridge/")) return Response.json([]);
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(10_000);
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`${server.url.href}?artifact=${kind}&unit=${encodeURIComponent(fixture.unit.unit_id)}`);
    // Hidden sections stay mounted, so count only what the first section shows.
    const marker = page.getByText(expected, { exact: true }).filter({ visible: true });
    await marker.waitFor();
    expect(await marker.count()).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); server.stop(true); }
}, 30_000);

test("a rejected assessment shows one visible notice in each presentation", async () => {
  const { unit, detail } = currentArtifactFixture("assessment");
  const revision = detail.revisions[0];
  const submit = { kind: "review", review: "assessment_review", target_revision_id: revision.id } as const;
  const feedback = "Recheck the verdict.";
  const assessmentReview: OperatorUnitView = { ...unit, recorded_decisions: [{
    id: "validation", decision_id: "validation", actor: null, reviewed_revision_id: revision.id, approved_assessment_revision_id: null, effect_target_revision_id: revision.id, review: "engine:validator", decision: "request_changes", effect: "request_changes",
    target_revision_id: revision.id, payload: { feedback }, created_at: revision.created_at,
  }], decisions: [
    { key: "accept", label: "Accept", operation: "approve_assessment", assessment: "assessment", fields: [], payload_schema: "{}",
      submit: { ...submit, decision: "accept", effect: "approve" } },
    { key: "request_assessment_changes", label: "Request assessment changes", operation: "plain", assessment: "assessment",
      fields: [{ key: "feedback", label: "Feedback" }], payload_schema: "{feedback: text}",
      submit: { ...submit, decision: "request_assessment_changes", effect: "request_changes" } },
  ] };
  const reviewing = { ...assessmentReview, reviews: [projectedReview({ review: "assessment_review", of_artifact: "assessment", reviewed_revision_id: revision.id }, assessmentReview.decisions)] };
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(10_000);
    await page.route("**/*", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: pageHtml });
      if (path === "/entry.js") return route.fulfill({ contentType: "application/javascript", body: script });
      if (path === "/oakridge/api/api/runs/run") return route.fulfill({ json: artifactRun });
      if (path.startsWith("/oakridge/api/api/definitions/")) return route.fulfill({ json: currentArtifactDefinition });
      if (path.endsWith("/assessments/assessment/status")) return route.fulfill({ json: {
        unit: reviewing.unit_id, assessment_artifact: "assessment", assessment_revision: revision.id,
        approval: { kind: "pending" }, unresolved_proposals: [], items: [], item_sources: [],
      } });
      return route.fulfill({ json: path.endsWith("/units") ? [reviewing] : path.endsWith("/artifacts/assessment") ? detail : [] });
    });
    await page.goto("http://oakridge.test/?artifact=assessment&unit=run%2Fcohort");
    await page.addStyleTag({ path: resolve(import.meta.dir, "../../core/pwa/styles.css") });
    const notice = page.getByText(`This assessment failed validation, so it cannot be accepted: ${feedback}`, { exact: true }).filter({ visible: true });
    await notice.waitFor();
    expect(await notice.count()).toBe(1);
    await page.getByRole("tab", { name: "structured" }).click();
    expect(await notice.count()).toBe(1);
  } finally { await page.close(); }
}, 30_000);
