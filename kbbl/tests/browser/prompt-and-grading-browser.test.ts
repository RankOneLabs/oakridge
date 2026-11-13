import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sampleUnits } from "../../core/pwa/oakridge/__fixtures__/read-models";
import { id, itemStatus, paged, reviewerAnswer, supportQuestion } from "../../core/pwa/oakridge/__fixtures__/grading";
import type { ObservationEvidenceReference } from "../../core/pwa/oakridge/grading-contracts/grading/evidence";

const screenshots = process.env.OAKRIDGE_DETAIL_SCREENSHOTS;
const root = resolve(import.meta.dir, "../../..");
const json = (body: unknown) => Response.json(body);
/** Real readers and components with frozen HTTP fixture data, styled by the production PWA build. */
test("prompt and grading detail browser handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oakridge-detail-browser-"));
  const output = join(directory, "entry.js");
  const built = Bun.spawnSync({ cmd: [process.execPath, "build", resolve(import.meta.dir, "prompt-and-grading-entry.tsx"), "--target=browser", `--outfile=${output}`], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  const script = readFileSync(output, "utf8");
  const assets = join(root, "kbbl/core/pwa/dist/assets");
  const cssFile = existsSync(assets) ? readdirSync(assets).find((file) => file.endsWith(".css")) : null;
  if (screenshots && !cssFile) throw new Error("Run bun run --filter kbbl build:pwa before browser screenshots");
  const css = cssFile ? readFileSync(join(assets, cssFile), "utf8") : "";
  const base = sampleUnits.find((unit) => unit.attempts.length > 0);
  if (!base?.attempts[0]) throw new Error("Fixture needs an attempt");
  const unit = { ...base, run_id: "run-1", stage: "implementation", attempts: [{ ...base.attempts[0], id: "recorded-attempt:1", worker: "builder", kbbl_session_id: "retained-session", intent: {
    prompt: { path: "workflow-config/prompts/development/build.md", digest: "sha256:84b56e39b0c460e944137f4429b7071fce2bd88852337a6a344ee68242d3b722" },
    inputs: { brief: { title: "Add the organization read endpoint", next_action: "Implement the pinned API contract and verify the response." } }, engine_inputs: { previous: null, subject: null, feedback: [] },
  } }] };
  const question = supportQuestion();
  const references: ObservationEvidenceReference[] = [
    { source: "revision", ref: "build_result", revision_id: id("build-result:revision-2"), item_path: "/tests", content: { passed: 42, failed: 0, summary: "All endpoint tests passed." } },
    { source: "run_input", ref: "original_spec", run_id: id("run-1"), input_path: "/spec", content: "Expose organization reads by recorded organization id." },
    { source: "repository", ref: "citation:0", repository_key: "oakridge", commit_sha: "80e0a459", path: "src/organizations.ts", line_range: { start: 20, end: 24 }, is_absent: false, content: "export const readOrganization = (id: OrganizationId) => store.read(id);" },
    { source: "reported", reported_by: "agent", ref: "citation:1", revision_id: id("assessment:revision-1"), item_path: "/findings/1/evidence/0", content: { kind: "output", citation: "worker test report", detail: "The worker reported that all 42 tests passed." } },
  ];
  const status = itemStatus([{ ...question, machine: { ...question.machine, items: question.machine.items.map((machine) => ({ ...machine, evaluator_definition_id: id("jev") })) }, evidence: { ...question.evidence, references: paged(references) }, superseded_answers: paged([reviewerAnswer("old-answer", "supports", "previous-reviewer", { is_current: false, comments: "Earlier answer before independent evidence was retained." })]) }]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (path === "/style.css") return new Response(css, { headers: { "content-type": "text/css" } });
    if (path.endsWith("/units")) return json([unit]);
    if (path.endsWith("/executed-prompt")) return json([
      { turn_id: "initial:preamble", created_at: "2026-11-12T12:00:00Z", text: "You are the Oakridge builder. Implement the recorded brief.\nYour publication secret: [redacted]\nKeep historical prompts and inputs separate." },
      { turn_id: "task:build", created_at: "2026-11-12T12:01:00Z", text: "Implement the organization read endpoint.\nAuthorization: Bearer [redacted]\nVerify the exact recorded contract and publish the build result." },
    ]);
    if (path.endsWith("/items/at")) return json(status.item);
    if (path.endsWith("/status")) return json(status);
    if (path.endsWith("/reviewer")) return json({ reviewer_id: "operator" });
    if (path.endsWith("/answers")) return json(paged([]));
    if (path.endsWith("/lineage")) return json({ occurrence_id: status.item.occurrence_id, relations: [], total: 0, limit: 20, offset: 0, republication: null });
    if (path.endsWith("/unresolved-task-references")) return json(paged([{ item: status.item, relation_id: "unresolved-1", unresolved_target_ref: "logical_item:task:T404", evidence_ref: "recorded worker association" }]));
    if (path.includes("/evaluator-definitions/")) return json({ evaluator_definition_id: path.split("/").at(-1), kind: path.endsWith("/human") ? "human" : "model", backend_kind: path.endsWith("/human") ? "human" : "jev_direct", model: path.endsWith("/human") ? null : "pinned-model-2026", instruction_text: "Evaluate only whether the frozen evidence supports the selected finding. Distinguish independently retrieved repository content from agent-reported output. Do not infer missing task associations." });
    if (path.startsWith("/oakridge/")) return json({ error: "unexpected fixture request" });
    return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`${server.url.href}?prompt&unit=${encodeURIComponent(unit.unit_id)}`);
    await page.getByText("Authorization: Bearer [redacted]", { exact: false }).waitFor();
    expect(await page.getByRole("heading", { name: "Session context" }).count()).toBe(1);
    expect(await page.getByText("Shared sessions can include other attempts and later tasks.", { exact: false }).count()).toBe(1);
    expect(await page.getByRole("region").count()).toBe(3);
    expect(await page.getByRole("textbox").count()).toBe(0);
    if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, "prompt-viewer.png"), fullPage: true }); }
    await page.goto(server.url.href);
    await page.getByTestId("or-item-panel").waitFor();
    expect(await page.getByTestId("or-evaluator-definition").count()).toBe(0);
    await page.getByTestId("or-item-reveal").click();
    await page.getByText("pinned-model-2026", { exact: true }).first().waitFor();
    await page.getByTestId("or-item-unresolved-task").first().waitFor();
    expect(await page.getByTestId("or-item-evidence-reference").count()).toBe(4);
    expect(await page.getByText("Independently retrieved", { exact: true }).count()).toBe(3);
    expect(await page.getByText("Reported", { exact: true }).count()).toBe(1);
    if (screenshots) await page.screenshot({ path: join(screenshots, "grading-detail.png"), fullPage: true });
    await page.getByTestId("or-item-hide").click();
    expect(await page.getByTestId("or-evaluator-definition").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
