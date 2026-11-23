import { expect, test } from "bun:test";
import { chromium, type Page } from "@playwright/test";
import { eventually, startStubKbbl } from "../../../oakridge-dbos/tests/stub-kbbl";
import { plan, repository, studyOperations } from "../../../oakridge-dbos/tests/study-fixture";
import type { RunView } from "../../../oakridge-dbos/src/projections/run-view";
import type { UnitView } from "../../../oakridge-dbos/src/projections/unit-view";
import { openDatabase, withTenant } from "../../../observation/src/storage/database";
import { withScratchStack } from "./scratch-stack";

const choiceQuestion = {
  id: "fixture.folio", scope: "per_item",
  targets: [{ artifact: "roadmap", selector: "/folios/*" }], evidence: ["subject"],
  question: { text: "Was a folio identified?", response: "choice", values: ["yes", "no"], missing_evidence_policy: "abstain",
    abstain_semantics: "Missing evidence", unclear_semantics: "Unclear", interpretation_caveats: "" },
  evaluators: [{ runner: "jev_direct", model: "fixture", estimated_cost_per_call: 0.01,
    instructions: { system_one: { type: "choice", instructions: "Check the folio.", criteria: { yes: "Yes", no: "No" } } } }],
};

async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function configureGrading(observation: string) {
  const base = `${observation}/v1/grading-config`;
  const headers = { authorization: "Bearer fixture-configure", "content-type": "application/json" };
  const saved = await read<{ digest: string }>(`${base}/draft`, { method: "PUT", headers, body: JSON.stringify({
    expected_draft_digest: null, document: { status: "draft", definitions: [choiceQuestion] },
  }) });
  await read(`${base}/publish`, { method: "POST", headers, body: JSON.stringify({
    expected_draft_digest: saved.digest, expected_latest_version: null,
  }) });
}

async function fillEpicFields(page: Page, title: string) {
  await page.getByLabel("Epic title").fill(title);
  await page.getByLabel("Brief notes", { exact: true }).fill("Verify the launch inputs.");
  await page.getByLabel("Repository 1 key").fill(repository.key);
  await page.getByLabel("Repository 1 GitHub owner").fill(repository.forge.owner);
  await page.getByLabel("Repository 1 GitHub name").fill(repository.forge.name);
  await page.getByLabel("Repository 1 path").fill(repository.preparation.repository_path);
  await page.getByLabel("Repository 1 integration branch").fill(repository.forge.final_base);
}

async function launchFromForm(page: Page, kbbl: string, workflow: string, fill: () => Promise<void>) {
  await page.goto(`${kbbl}/#oakridge/new-run`);
  await page.getByRole("option", { name: workflow, exact: true }).waitFor({ state: "attached" });
  await page.getByLabel("Workflow Definition").selectOption({ label: workflow });
  await fill();
  const committed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/api/runs"));
  await page.getByRole("button", { name: "Start Run" }).click();
  const response = await committed;
  const result = await response.json() as { readonly run_id?: string };
  if (!response.ok() || !result.run_id) throw new Error(`Run launch refused: ${JSON.stringify(result)}`);
  await page.waitForURL(`**#oakridge/run/${result.run_id}`);
  return result.run_id;
}

test("a renamed workflow runs from the browser through capture and grading, then study receives its approved plan", async () => {
  let publicationError: Error | null = null;
  const agents = startStubKbbl(async (turn) => {
    const worker = /worker `([^`]+)`/.exec(turn.preamble)?.[1];
    const artifact = worker === "cartographer" ? "roadmap" : worker === "scribe" ? "manuscript" : worker === "reader" ? "appraisal" : null;
    if (!artifact) return "succeeded";
    const body = artifact === "roadmap" ? { folios: ["opening"] }
      : artifact === "manuscript" ? { prose: "An opening folio." }
        : { remarks: [], closure_checks: [] };
    const response = await turn.publish(artifact, body, { subject: turn.subject() });
    if (!response.ok) {
      publicationError = new Error(`Publication refused for ${artifact}: ${await response.text()}`);
      throw publicationError;
    }
    return "succeeded";
  });
  try {
    await withScratchStack({
      agents, operations: studyOperations,
      runners: () => ({ kind: "model", run: async (_input, onRequest) => {
        await onRequest?.();
        return { ok: true, value: { answer: { state: "answered", kind: "choice", value: "yes" } } };
      } }),
    }, async ({ core, kbbl, observation, observationDatabase }) => {
      await configureGrading(observation);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(15_000);
        const run = await launchFromForm(page, kbbl, "portability", async () => {
          await page.getByLabel("headline", { exact: true }).fill("Folio trial");
          await page.getByLabel("destinations", { exact: true }).fill('["archive"]');
          await page.getByTestId("or-new-run-automatic-grading-input").check();
          await page.getByRole("button", { name: "Per session" }).click();
          await page.getByLabel("drafting · Scribe model").waitFor();
          await page.getByLabel("drafting · Reader model").waitFor();
        });
        const units = (runId: string) => read<readonly UnitView[]>(`${core}/api/runs/${runId}/units`);
        await eventually("the renamed assessment review", async () => {
          if (publicationError) throw publicationError;
          return (await units(run)).find((unit) => unit.reviews.some((review) => review.review === "appraisal_desk"));
        });
        await page.goto(`${kbbl}/#oakridge/run/${run}`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("or-sidebar-artifact").filter({ hasText: "appraisal" }).click();
        await page.getByTestId("or-assessment-viewer").waitFor().catch(async (error: unknown) => {
          throw new Error(`The pinned assessment viewer did not render: ${await page.locator("body").innerText()}`, { cause: error });
        });
        await page.getByRole("button", { name: "Return the reader's notes", exact: true }).waitFor();
        await page.getByRole("button", { name: "Endorse the manuscript", exact: true }).click();
        await eventually("run completion after its browser decision", async () =>
          (await read<RunView>(`${core}/api/runs/${run}`)).status.kind === "done");
        const db = openDatabase(observationDatabase);
        try {
          await eventually("a grade produced by the stub evaluator", async () => {
            const grades = await withTenant(db, { producer: "oakridge", namespace: "portability" }, (trx) =>
              trx.selectFrom("observation.grade_observation").select("execution_id").execute());
            return grades.length > 0;
          });
        } finally { await db.destroy(); }
        const capture = await eventually("unregistered manuscript declaration", async () => {
          const view = await read<{ issues: { items: { kind: string }[] } }>(`${observation}/v1/runs/${run}/items`, {
            headers: { authorization: "Bearer fixture-read" },
          });
          return view.issues.items.find((issue) => issue.kind === "unregistered_declaration");
        });
        expect(capture.kind).toBe("unregistered_declaration");
        const study = await launchFromForm(page, kbbl, "study", async () => {
          await fillEpicFields(page, "Study");
          await page.getByLabel("Slice case limit").fill("2");
          await page.getByLabel("Slice spending cap (USD)").fill("1.00");
          await page.getByLabel("approved plan", { exact: true }).fill(JSON.stringify(plan));
        });
        const design = await eventually("the designer attempt with an approved plan", async () =>
          (await units(study)).find((unit) => unit.stage === "design" && unit.attempts.some((attempt) => attempt.worker === "designer" && attempt.intent)));
        expect(design.input).toMatchObject({ approved_plan: plan });
        expect(design.attempts.find((attempt) => attempt.worker === "designer")?.intent?.inputs).toMatchObject({ approved_plan: plan });
        const development = await launchFromForm(page, kbbl, "development", async () => {
          await fillEpicFields(page, "Launch regression");
          await page.getByLabel("Planner model").waitFor();
        });
        const root = (await units(development)).find((unit) => unit.stage === null);
        expect(root?.input).toMatchObject({
          title: "Launch regression", spec: "Verify the launch inputs.", primary_repository_key: repository.key,
          repositories: [{ forge: { build_base: "epic/launch-regression", final_base: repository.forge.final_base } }],
          final_merge_policy: "require_merge",
        });
      } finally { await browser.close(); }
    });
  } finally { agents.stop(); }
}, 120_000);
