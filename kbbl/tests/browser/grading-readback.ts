/**
 * Drives the real PWA of a running stack for the live proof in observation/verification: the same
 * operator flow the fixture test covers, here against real captured items and real provider answers.
 * It lives here because the browser driver is this package's dependency. It starts nothing.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

export interface ItemAddress { readonly source_revision_id: string; readonly item_path: string }
export interface ReadbackStep { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface ReadbackResult { readonly steps: readonly ReadbackStep[]; readonly screenshots: readonly string[] }
export interface LiveTarget { readonly kbbl_url: string; readonly run_id: string; readonly screenshot_dir: string }
const NAVIGATION_MS = 30_000;
/** A whole flow's limit, so a stuck page ends as a failed step and the proof still writes its report. */
const FLOW_MS = 300_000;
/** Closing a browser has been seen never to settle after the browser has gone, so it is not waited on past this. */
const CLOSE_MS = 10_000;
const ACTION_MS = 10_000;
/** Headless Chromium occasionally stops producing the frames a stability check waits for, with the page
 * itself still live. Then the element is clicked directly, since this flow reads back what follows. */
const click = (target: Locator): Promise<void> => target.click({ timeout: ACTION_MS }).catch(() => target.evaluate((element) => { (element as HTMLElement).click(); }));
const expired = (ms: number, value: string): Promise<string> => new Promise((resolve) => { setTimeout(() => resolve(value), ms).unref?.(); });

async function withPage(target: LiveTarget, work: (page: Page, step: (name: string, passed: boolean, detail: string) => void, shot: (name: string) => Promise<void>) => Promise<void>): Promise<ReadbackResult> {
  await mkdir(target.screenshot_dir, { recursive: true });
  const steps: ReadbackStep[] = [];
  const screenshots: string[] = [];
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(NAVIGATION_MS);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${target.kbbl_url}/#oakridge/run/${encodeURIComponent(target.run_id)}`);
    const flow = work(page, (name, passed, detail) => { steps.push({ name, passed, detail }); }, async (name) => {
      const path = join(target.screenshot_dir, `${name}.png`);
      await page.screenshot({ path });
      screenshots.push(path);
    }).then(() => "completed").catch((cause: unknown) => cause instanceof Error ? cause.message : String(cause));
    const ended = await Promise.race([flow, expired(FLOW_MS, `no result within ${FLOW_MS} ms`)]);
    if (ended !== "completed") steps.push({ name: "the browser flow completes", passed: false, detail: ended });
    steps.push({ name: "the page raised no error", passed: errors.length === 0, detail: errors.join("; ") || "none" });
  } finally { await Promise.race([browser.close(), expired(CLOSE_MS, "unsettled")]); }
  return { steps, screenshots };
}

const findingRow = (page: Page, address: ItemAddress) => page.locator(`[data-testid="or-stage-finding"][data-revision="${address.source_revision_id}"][data-item-path="${address.item_path}"]`);
const panelOf = (page: Page, address: ItemAddress) => page.locator(`[data-testid="or-item-panel"][data-revision="${address.source_revision_id}"][data-item-path="${address.item_path}"]`);

async function openGrading(page: Page): Promise<void> {
  await click(page.getByTestId("or-sidebar-pane-grading"));
  await page.getByTestId("or-grading-section").waitFor();
}
async function openFromGrading(page: Page, address: ItemAddress): Promise<void> {
  await findingRow(page, address).waitFor();
  await click(findingRow(page, address).getByTestId("or-grade-item"));
  await panelOf(page, address).waitFor();
}

export interface NotReadyInput extends LiveTarget { readonly item: ItemAddress; readonly question_id: string; readonly code: string }
/** The selected not-ready question shows its reason and no choices, and nothing else on the item is held back. */
export function readNotReadyPanel(input: NotReadyInput): Promise<ReadbackResult> {
  return withPage(input, async (page, step, shot) => {
    await openGrading(page);
    await openFromGrading(page, input.item);
    await click(page.locator(`[data-testid="or-item-question"][data-question="${input.question_id}"]`));
    const reason = await page.getByTestId("or-your-grade-not-ready").innerText();
    step("the not-ready question shows its reason", reason.includes(input.code), reason);
    step("the not-ready question offers no choice", await page.getByTestId("or-your-grade-choice").count() === 0, "no radio rendered");
    await shot("question-not-ready");
  });
}

export interface WorkspaceReadbackInput extends LiveTarget {
  /** An assessment finding already holding a real provider answer and a reviewer answer. */
  readonly answered: ItemAddress;
  readonly answered_question_id: string;
  readonly machine_observation_id: string;
  readonly human_observation_id: string;
  readonly hidden_markers: readonly string[];
  /** An analysis finding this flow answers and corrects in the browser. */
  readonly browser_item: ItemAddress;
  readonly browser_first_choice: string;
  readonly browser_second_choice: string;
}
export interface BrowserSubmission { readonly status: number; readonly observation_id: string | null; readonly corrects_observation_id: string | null; readonly reviewer_id: string | null }
export interface WorkspaceReadback extends ReadbackResult { readonly submissions: readonly BrowserSubmission[] }

/** Every entry point opens the same occurrence, answers stay hidden until asked for, and saved follows the acknowledgment. */
export async function readWorkspace(input: WorkspaceReadbackInput): Promise<WorkspaceReadback> {
  const submissions: BrowserSubmission[] = [];
  const result = await withPage(input, async (page, step, shot) => {
    const leaked = async (): Promise<readonly string[]> => {
      const text = await page.locator("body").innerText();
      const html = await page.content();
      return input.hidden_markers.filter((marker) => text.includes(marker) || html.includes(marker));
    };
    await openGrading(page);
    await page.getByTestId("or-stage-finding").first().waitFor();
    step("hidden: the grading section shows no composite count", await page.getByTestId("or-task-answer-count").count() === 0 && await page.getByTestId("or-grading-spend").count() === 0, "no count rendered");
    step("hidden: no other answer, reviewer or grader is anywhere on the page", (await leaked()).length === 0, `leaked: ${(await leaked()).join(", ") || "none"}`);
    await shot("grading-hidden");

    // The answered finding, reached with no task or cohort: its address is all the panel is given.
    await openFromGrading(page, input.answered);
    const panel = panelOf(page, input.answered);
    const occurrence = await panel.getAttribute("data-occurrence");
    await click(page.locator(`[data-testid="or-item-question"][data-question="${input.answered_question_id}"]`));
    await page.getByTestId("or-item-answers-hidden").waitFor();
    const evaluators = await page.getByTestId("or-item-machine-status").count();
    const others = await page.getByTestId("or-item-answers").count();
    step("hidden: the panel omits other answers and evaluators and keeps the form", evaluators === 0 && others === 0 && await page.getByTestId("or-your-grade").count() === 1, `${evaluators} evaluator rows, ${others} answer sections`);
    await shot("item-hidden");
    await click(page.getByTestId("or-item-reveal"));
    await page.getByTestId("or-item-answers").waitFor();
    const rows = page.getByTestId("or-item-answers").getByTestId("or-item-answer");
    const seen = await rows.evaluateAll((elements) => elements.map((element) => [element.getAttribute("data-observation"), element.getAttribute("data-grader")]));
    step("revealed before this page answered anything: the real provider answer is shown as a machine's", seen.some(([id, grader]) => id === input.machine_observation_id && grader === "machine"), JSON.stringify(seen));
    step("the authenticated human answer is shown as a reviewer's", seen.some(([id, grader]) => id === input.human_observation_id && grader === "human"), JSON.stringify(seen));
    await shot("item-revealed");

    // A browser answer and correction: saved only with the acknowledgment.
    await click(page.getByTestId("or-item-hide"));
    await openFromGrading(page, input.browser_item);
    const browserPanel = panelOf(page, input.browser_item);
    const submit = async (choice: string, label: string): Promise<void> => {
      await click(browserPanel.locator(`[data-testid="or-your-grade-choice"][value="${choice}"]`));
      step(`${label}: saved is not shown before the acknowledgment`, await page.getByTestId("or-your-grade-saved").count() === 0, "absent");
      const answered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/oakridge/observation/items/"));
      await click(page.getByTestId("or-your-grade-submit"));
      const response = await answered;
      const body = await response.json() as { readonly observation_id?: string; readonly corrects_observation_id?: string | null; readonly reviewer_id?: string };
      submissions.push({ status: response.status(), observation_id: body.observation_id ?? null, corrects_observation_id: body.corrects_observation_id ?? null, reviewer_id: body.reviewer_id ?? null });
      const saved = await page.getByTestId("or-your-grade-saved").innerText();
      step(`${label}: saved follows the service's acknowledgment`, response.status() === 201 && saved.includes(choice.replaceAll("_", " ")), `${response.status()}; ${saved}`);
    };
    await browserPanel.getByTestId("or-your-grade").waitFor();
    await submit(input.browser_first_choice, "first answer");
    await page.getByTestId("or-your-grade-current").waitFor();
    await shot("item-saved");
    await page.waitForFunction(() => document.querySelector('[data-testid="or-your-grade-submit"]')?.textContent === "Correct your answer");
    await submit(input.browser_second_choice, "correction");
    await page.getByTestId("or-your-grade-history").waitFor();
    step("the correction keeps the earlier answer", (await page.getByTestId("or-your-grade-history").innerText()).includes(input.browser_first_choice.replaceAll("_", " ")), "history listed");
    await shot("item-corrected");

    // The same finding from the artifact viewers.
    const fromViewer = async (artifact: RegExp, address: ItemAddress, name: string): Promise<void> => {
      await click(page.getByTestId("or-sidebar-artifact").filter({ hasText: artifact }).first());
      await page.getByTestId("or-artifact-type").waitFor();
      const toggle = page.getByText(/Show met criteria/);
      if (await toggle.count() > 0) await click(toggle);
      const button = page.locator(`[data-testid="or-grade-item"][data-item-path="${address.item_path}"]`).first();
      await click(button);
      await panelOf(page, address).waitFor();
      step(`${name} opens the same occurrence`, await panelOf(page, address).getAttribute("data-occurrence") !== null, address.item_path);
      await shot(name.replaceAll(" ", "-"));
    };
    await fromViewer(/dev\.assessment/, input.answered, "assessment viewer");
    step("the assessment viewer's panel is the grading section's item", await panelOf(page, input.answered).getAttribute("data-occurrence") === occurrence, occurrence ?? "");
    await fromViewer(/Spec analysis/, input.browser_item, "analysis viewer");

    // Composites stay hidden through all of that, and reveal on their own.
    await openGrading(page);
    step("hidden: submitting revealed no composite", await page.getByTestId("or-task-answer-count").count() === 0, "no count rendered");
    await click(page.getByTestId("or-composites-reveal"));
    await page.getByTestId("or-task-answer-count").first().waitFor();
    await click(page.getByTestId("or-task-answer-count").first());
    await page.getByTestId("or-task-drilldown-row").first().waitFor();
    step("a composite count opens its raw answers", await page.getByTestId("or-task-drilldown").getByTestId("or-item-answer").count() > 0, "raw answers listed");
    await shot("task-drilldown");

    // The arrangement restores by address alone.
    await page.reload();
    await page.getByTestId("or-run-workspace").waitFor();
    step("a reload restores the workspace", await page.getByTestId("or-run-panes").count() === 1, "restored");
  });
  return { ...result, submissions };
}
