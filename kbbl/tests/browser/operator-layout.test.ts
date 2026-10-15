import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import capturedRun from "../../core/pwa/oakridge/__fixtures__/v2-adapter-sample.json";

const root = resolve(import.meta.dir, "../../..");
const runId = capturedRun.run.run_id;
const html = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div class="or-shell"><main class="or-shell__content" id="app"></main></div><script type="module" src="/entry.js"></script>';

function buildBrowserAssets(): { readonly script: string; readonly css: string } {
  const jsPath = "/tmp/oakridge-layout-entry.js";
  const js = Bun.spawnSync({ cmd: [process.execPath, "build", resolve(import.meta.dir, "operator-browser-entry.tsx"),
    "--target=browser", `--outfile=${jsPath}`], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (js.exitCode !== 0) throw new Error(js.stderr.toString());
  const styles = Bun.spawnSync({ cmd: [process.execPath, "run", "build:pwa"], cwd: resolve(root, "kbbl"),
    stdout: "pipe", stderr: "pipe" });
  if (styles.exitCode !== 0) throw new Error(styles.stderr.toString());
  const assets = resolve(root, "kbbl/core/pwa/dist/assets");
  const cssName = readdirSync(assets).find((file) => file.endsWith(".css"));
  if (!cssName) throw new Error("PWA build produced no stylesheet");
  return { script: readFileSync(jsPath, "utf8"), css: readFileSync(resolve(assets, cssName), "utf8") };
}

test("run stages and side-by-side panes fit without horizontal scrolling", async () => {
  const { script, css } = buildBrowserAssets();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (path === "/style.css") return new Response(css, { headers: { "content-type": "text/css" } });
    if (path === `/oakridge/api/api/runs/${runId}`) return Response.json(capturedRun.run);
    if (path === `/oakridge/api/api/runs/${runId}/units`) return Response.json(capturedRun.units);
    if (path === "/oakridge/api/run_events") return Response.json([]);
    if (path.startsWith("/oakridge/api/")) return Response.json({ error: "missing fixture" }, { status: 404 });
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (const width of [1440, 1024, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${server.url.href}?run=${runId}`);
        await page.getByTestId("or-run-overview").waitFor();
        if (width < 768) await page.getByTestId("or-sidebar-toggle").click();
        await page.getByTestId("or-sidebar-pane-list").click();
        await page.getByTestId("or-run-detail").waitFor();
        if (width === 1440) {
          const stages = await page.getByTestId("or-stage-name").allTextContents();
          expect(stages.some((stage) => stage.includes("analysis"))).toBe(true);
          expect(stages.some((stage) => stage.includes("planning"))).toBe(true);
          expect(stages.some((stage) => stage.includes("brief"))).toBe(true);
        }
        const assertFits = async () => {
          const overflow = await page.evaluate(() => {
            const selectors = [".or-run-workspace__pane", "[data-testid=or-run-detail]", "[data-testid=or-run-gate-list]",
              "[data-testid=or-gate-card]", "[data-testid=or-run-detail] .overflow-x-auto", ".or-run-identity__names"];
            const elements = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
            return { document: document.documentElement.scrollWidth > innerWidth + 1,
              elements: elements.filter((element) => element.scrollWidth > element.clientWidth + 1)
                .map((element) => element.getAttribute("data-testid") ?? element.className) };
          });
          expect(overflow).toEqual({ document: false, elements: [] });
        };
        await assertFits();
        if (width === 390) {
          const canScrollVertically = await page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>("[data-testid=or-run-pane-primary]");
            if (!pane) return false;
            pane.scrollTop = pane.scrollHeight;
            return pane.scrollTop > 0;
          });
          expect(canScrollVertically).toBe(true);
        }
        if (width >= 768) {
          await page.getByTestId("or-sidebar-pane-overview-twin").click();
          await assertFits();
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); server.stop(true); }
}, 60_000);
