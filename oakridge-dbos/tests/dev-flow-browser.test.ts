/** Browser and failed-publication boundaries against the seeded v15 runtime. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { WorkflowRunId } from "../src/domain/primitives";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { runContext, awaitCondition, installIntegrationRuntime, scriptedAgentScenario, useScenario, type IntegrationRuntime } from "./support/dev-flow-harness";
import { listRunGates, readRun, launchRun } from "./support/dev-flow-driver";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";
import { cohortMachineState } from "./support/v15-run-queries";
const acceptanceEnabled = process.env.OAKRIDGE_ACCEPTANCE === "1";
let scratch: ScratchDatabase | null = null;
const e2e = acceptanceEnabled ? test : test.skip;
let oakridge: IntegrationRuntime;
let sql: PgPostgresExecutor;
let browser: Browser;

if (acceptanceEnabled) {
  beforeAll(async () => {
    const created = await createScratchDatabase(`oakridge_browser_${crypto.randomUUID().replaceAll("-", "")}`);
    if (!created.ok) throw new Error(created.error.detail);
    scratch = created.value;
    oakridge = await installIntegrationRuntime(scratch.url, { scratch_database: scratch });
    sql = PgPostgresExecutor.connect(scratch.url);
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterEach(async () => {
    if (!oakridge) return;
    // A failed assertion must not leave an agent running against the next
    // test's fake forge/scenario. Cancel through the same public boundary.
    const runs = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly {
      readonly id: string; readonly status: string;
    }[];
    for (const run of runs.filter((run) => run.status === "active" || run.status === "pending")) {
      const response = await fetch(`${oakridge.base_url}/workflow_runs/${run.id}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error(`acceptance cleanup could not cancel ${run.id}: ${await response.text()}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (oakridge) await oakridge.stop();
    if (browser) await browser.close();
    if (sql) await sql.close();
    if (scratch) await scratch.drop();
  }, 60_000);
}

const launchBrowserRun = async (page: Page, title: string) => {
  const repository_key = "oakridge";
  const before = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly { readonly id: string }[];
  const beforeIds = new Set(before.map((run) => run.id));
  await page.goto(`${oakridge.kbbl_url}/#oakridge/new-run`);
  await page.getByLabel("Epic title").fill(title);
  await page.getByLabel("Repository 1 key").fill(repository_key);
  await page.getByLabel("Repository 1 GitHub owner").fill("RankOneLabs");
  await page.getByLabel("Repository 1 GitHub name").fill("oakridge");
  await page.getByLabel("Repository 1 path").fill(oakridge.repository.path);
  await page.getByRole("textbox", { name: "Brief notes", exact: true }).fill("browser acceptance");
  await page.getByRole("button", { name: "Start Run" }).click();
  const launched = await awaitCondition("browser launch to appear in the public API", async () => {
    const runs = await fetch(`${oakridge.base_url}/runs`).then((response) => response.json()) as readonly {
      readonly id: string; readonly current_attempt_root_workflow_id: string }[];
    return runs.find((run) => !beforeIds.has(run.id)) ?? null;
  }, 30_000);
  oakridge.started_runs.push(launched.current_attempt_root_workflow_id);
  return { run_id: launched.id as WorkflowRunId, root_workflow_id: launched.current_attempt_root_workflow_id,
    repository_key };
};

e2e("S21/S22 browser launches, refuses artifact overwrite, and accepts exact analysis through kbbl", async () => {
  const agent = scriptedAgentScenario();
  useScenario(agent);
  const page = await browser.newPage();
  try {
    const launched = await launchBrowserRun(page, "Browser acceptance run");
    let latestRun: Awaited<ReturnType<typeof readRun>> | null = null;
    const gate = await awaitCondition(() => `v15 analysis review; current run: ${JSON.stringify(latestRun)}`, async () => {
      latestRun = await readRun(oakridge.base_url, launched.run_id);
      return (await listRunGates(oakridge.base_url, launched.run_id))
        .find((candidate) => candidate.stage_name === "spec_analysis") ?? null;
    }, 30_000);
    const beforeEdit = await sql.query("SELECT id,revision,body FROM oakridge.artifact WHERE id=$1", [gate.artifact_revision_id]);
    const edit = await fetch(`${oakridge.base_url}/artifacts/${gate.artifact_revision_id}/edits`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: "operator overwrite" }) });
    expect([400, 501]).toContain(edit.status);
    expect(await sql.query("SELECT id,revision,body FROM oakridge.artifact WHERE id=$1", [gate.artifact_revision_id])).toEqual(beforeEdit);
    await page.goto(`${oakridge.kbbl_url}/#oakridge/review-inbox`);
    await page.getByRole("button", { name: "Accept analysis" }).first().click();
    await awaitCondition("browser gate decision in the public API", async () =>
      (await listRunGates(oakridge.base_url, launched.run_id)).some((candidate) => candidate.id === gate.id) ? null : true, 30_000);
    const detail = await awaitCondition("spec analysis stage completion", async () => {
      const run = await readRun(oakridge.base_url, launched.run_id);
      return run.stages.find((stage) => stage.name === "spec_analysis")?.status === "complete" ? run : null;
    }, 30_000);
    expect(detail.stages.find((stage) => stage.name === "spec_analysis")?.status).toBe("complete");
    expect([...agent.launched.values()].filter((launch) =>
      launch.expected_artifacts.some((output) => output.output_name === "spec_analysis"))).toHaveLength(1);
  } finally {
    await page.close();
    agent.releaseAll();
  }
}, 240_000);

e2e("S20 missing publication contract interrupts the v15 spec worker", async () => {
  const agent = scriptedAgentScenario({ strip_publication_contract: true });
  useScenario(agent);
  const launched = await launchRun(oakridge.base_url, oakridge.definition.id, runContext(oakridge.base_url, oakridge.repository.path));
  oakridge.started_runs.push(launched.root_workflow_id);
  try {
    const diagnosis = await awaitCondition("the run to record a failed agent attempt", async () => {
      const response = await fetch(`${oakridge.base_url}/runs/${launched.run_id}/diagnosis`);
      const value = await response.json() as { readonly sessions?: readonly { readonly status: string }[] };
      return value.sessions?.some((session) => session.status === "failed") ? value : null;
    }, 30_000);
    expect(diagnosis.sessions?.some((session) => session.status === "failed")).toBe(true);
    const refusedPrompt = agent.deliveries.find((delivery) => delivery.delivery_key.startsWith("missing-publication-contract"))?.prompt;
    expect(refusedPrompt).toBeDefined();
    expect(refusedPrompt).not.toContain("## Oakridge v2 artifact publication");
    const detail = await awaitCondition("failed publication attempt to interrupt the worker", async () => {
      const run = await readRun(oakridge.base_url, launched.run_id);
      const unit = run.stages.find((stage) => stage.name === "spec_analysis")?.units[0];
      return unit?.workers?.some((worker) => worker.worker === "spec" && worker.record.state === "interrupted") ? run : null;
    }, 30_000);
    expect(detail.status).toBe("active");
    expect(await cohortMachineState(sql, launched.run_id, "spec_analysis", "spec_analysis")).toBe("working");
  } finally {
    agent.releaseAll();
  }
}, 60_000);


