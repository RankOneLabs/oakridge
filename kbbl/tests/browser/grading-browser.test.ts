import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import capturedRun from "../../core/pwa/oakridge/__fixtures__/v2-adapter-sample.json";
import { acknowledged, correctnessQuestion, findingRow, IMPLEMENTATION, INTEGRATION, ANALYSIS, item, itemStatus, paged, reviewerAnswer, supportQuestion, taskComposite } from "../../core/pwa/oakridge/__fixtures__/grading";

/** Reviewable screenshots of the changed views land here when a directory is named, and are skipped otherwise. */
const SCREENSHOTS = process.env.OAKRIDGE_GRADING_SCREENSHOTS ? resolve(process.env.OAKRIDGE_GRADING_SCREENSHOTS) : null;
const runId = capturedRun.run.run_id;
const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const pageHtml = '<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>';

let browser: Browser;
let script: string;
beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), "oakridge-grading-browser-"));
  const output = join(directory, "entry.js");
  try {
    const built = Bun.spawnSync({ cmd: [process.execPath, "build", resolve(import.meta.dir, "operator-browser-entry.tsx"), "--target=browser", `--outfile=${output}`], cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`Browser fixture build failed: ${built.stderr.toString()}`);
    script = readFileSync(output, "utf8");
  } finally { rmSync(directory, { recursive: true, force: true }); }
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  if (SCREENSHOTS) mkdirSync(SCREENSHOTS, { recursive: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

interface World { readonly submitted: unknown[]; own: readonly ReturnType<typeof reviewerAnswer>[] }
function observationRead(url: URL, world: World): Response | null {
  const path = url.pathname.replace("/oakridge/observation", "");
  if (path === "/reviewer") return json({ reviewer_id: "oakridge-operator" });
  if (path.endsWith("/items/at")) return json(item(IMPLEMENTATION));
  if (path.endsWith("/status")) return json(itemStatus([supportQuestion(), correctnessQuestion()]));
  if (path.includes("/items/") && path.endsWith("/lineage")) return json({ occurrence_id: "o", relations: [], total: 0, limit: 20, offset: 0, republication: null });
  if (path.endsWith("/answers")) return json(paged(world.own));
  if (path.endsWith("/grading")) return json({ run_id: runId, is_grading_enabled: true, committed: 0.03, requests_sent: 3, attempts: 3, executions: { completed: 3 } });
  if (path.endsWith("/findings")) {
    const stage = url.searchParams.get("stage");
    if (stage === "analysis") return json(paged([findingRow(ANALYSIS, { stage: "analysis", selected_value: { description: "An analysis finding with no task" } })]));
    if (stage === "implementation") return json(paged([findingRow(IMPLEMENTATION)]));
    return json(paged([findingRow(INTEGRATION, { stage: "integration", selected_value: { description: "An unlinked integration finding" } })]));
  }
  if (path.endsWith("/unresolved-task-references")) return json(paged([]));
  if (path.endsWith("/tasks")) return json(paged([taskComposite()]));
  if (path.endsWith("/tasks/T1")) return json(taskComposite());
  if (path.endsWith("/tasks/T1/lineage")) return json({ ...paged([{ kind: "contribution", relation_id: "r", evidence_ref: "e", asserted_by: "producer_explicit", item: item(IMPLEMENTATION) }]), run_id: runId, producer_local_id: "T1", is_captured: true });
  if (path.endsWith("/drilldown")) return json(paged([{ item: item(IMPLEMENTATION), links: paged([]), questions: paged([{ question: { question_id: "assessment_finding.evidence_support", question_version: "1" }, evidence: supportQuestion().evidence, statuses: paged([]),
    answers: paged([reviewerAnswer("raw", "does_not_support", "second-reviewer")]), superseded_answers: paged([]) }]) }]));
  return null;
}
function serve(world: World) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (url.pathname === "/oakridge/config") return json({ available: true, core_url: "http://127.0.0.1:8790" });
    if (url.pathname === "/config") return json({ defaultWorkdir: "/repo", defaultRuntimeId: "claude-code", runtimes: [] });
    if (url.pathname.startsWith("/oakridge/observation")) {
      if (request.method === "POST") {
        world.submitted.push(await request.json());
        world.own = [reviewerAnswer("new-observation", "does_not_support")];
        return json(acknowledged("does_not_support"), 201);
      }
      return observationRead(url, world) ?? json({ error: { code: "unexpected", message: url.pathname } }, 404);
    }
    if (url.pathname === `/oakridge/api/api/runs/${runId}`) return json(capturedRun.run);
    if (url.pathname === `/oakridge/api/api/runs/${runId}/units`) return json(capturedRun.units);
    if (url.pathname === "/oakridge/api/run_events") return json([]);
    if (url.pathname === "/oakridge/api/api/projects") return json({ items: [] });
    if (url.pathname.startsWith("/oakridge/api/")) return json({ error: "unexpected browser API request" }, 404);
    return new Response(pageHtml, { headers: { "content-type": "text/html" } });
  } });
}
const shot = async (page: Page, name: string) => { if (SCREENSHOTS) await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), fullPage: true }); };
const bodyText = (page: Page) => page.locator("body").innerText();

test("the grading section opens one item panel: hidden first, explicit reveal, acknowledged save and task drilldown", async () => {
  const world: World = { submitted: [], own: [] };
  const server = serve(world);
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`${server.url.href}?run=${encodeURIComponent(runId)}`);
    await page.getByTestId("or-sidebar-pane-grading").click();
    await page.getByTestId("or-grading-section").waitFor();
    await page.getByTestId("or-grading-task").waitFor();
    await page.getByTestId("or-stage-finding").nth(2).waitFor();
    // Hidden: tasks and findings are listed, nothing answer-derived is on the page.
    expect(await page.getByTestId("or-task-answer-count").count()).toBe(0);
    for (const marker of ["does not support", "Budget deferred", "Disagreement", "provider requests"]) expect(await bodyText(page)).not.toContain(marker);
    await shot(page, "grading-section-hidden");

    // An unlinked integration finding opens the same panel as any other, beside the section.
    await page.locator('[data-testid="or-stage-finding"][data-stage], [data-testid="or-stage-finding"]').nth(2).getByTestId("or-grade-item").click();
    await page.getByTestId("or-item-panel").waitFor();
    await page.getByTestId("or-item-answers-hidden").waitFor();
    expect(await page.getByTestId("or-item-answer").count()).toBe(0);
    expect(await bodyText(page)).not.toContain("second-reviewer");
    await shot(page, "item-panel-hidden");

    // Reveal is available before any answer and sends nothing.
    await page.getByTestId("or-item-reveal").click();
    await page.getByTestId("or-item-answers").waitFor();
    expect(await bodyText(page)).toContain("Reviewer second-reviewer");
    expect(world.submitted).toEqual([]);
    await shot(page, "item-panel-revealed");
    await page.getByTestId("or-item-hide").click();
    expect(await page.getByTestId("or-item-answers").count()).toBe(0);

    // The not-ready question is the only one disabled.
    await page.locator('[data-testid="or-item-question"][data-question="assessment_finding.correctness"]').click();
    await page.getByTestId("or-your-grade-not-ready").waitFor();
    expect(await page.getByTestId("or-your-grade-choice").count()).toBe(0);
    await page.locator('[data-testid="or-item-question"][data-question="assessment_finding.evidence_support"]').click();

    // Saved appears only on the acknowledgment, and reveals this item.
    await page.getByTestId("or-your-grade-choice").nth(1).check();
    await page.getByTestId("or-your-grade-rationale").fill("The cited line says otherwise.");
    expect(await page.getByTestId("or-your-grade-saved").count()).toBe(0);
    await page.getByTestId("or-your-grade-submit").click();
    await page.getByTestId("or-your-grade-saved").waitFor();
    await page.getByTestId("or-item-answers").waitFor();
    expect(world.submitted).toMatchObject([{ question_id: "assessment_finding.evidence_support", answer: "does_not_support", rationale: "The cited line says otherwise.", corrects_observation_id: null }]);
    await page.getByTestId("or-your-grade-current").waitFor();
    await shot(page, "item-panel-saved");
    // That revealed its item only: composites stay hidden.
    expect(await page.getByTestId("or-task-answer-count").count()).toBe(0);

    // Composite reveal is its own act, and every count opens raw answers.
    await page.getByTestId("or-composites-reveal").click();
    await page.getByTestId("or-task-answer-count").click();
    await page.getByTestId("or-task-drilldown-row").waitFor();
    expect(await page.getByTestId("or-task-drilldown").innerText()).toContain("second-reviewer");
    await shot(page, "task-drilldown");
    expect(errors).toEqual([]);
  } finally { await context.close(); await server.stop(true); }
}, 60_000);
