import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { configRead, publishedConfig } from "../../core/pwa/oakridge/__tests__/grading-config-fixture";

let browser: Browser;
let script: string;
beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), "oakridge-grading-config-browser-"));
  const output = join(directory, "entry.js");
  try {
    const result = Bun.spawnSync({ cmd: [process.execPath, "build", resolve(import.meta.dir, "grading-config-browser-entry.tsx"), "--target=browser", "--outfile=" + output], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error("Browser fixture build failed: " + result.stderr.toString());
    script = readFileSync(output, "utf8");
  } finally { rmSync(directory, { recursive: true, force: true }); }
  browser = await chromium.launch({ args: ["--no-sandbox"] });
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each(["shell", "back", "forward"])("cancelled %s navigation preserves the grading draft in Chromium", async (direction) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
    if (path === "/oakridge/config") return Response.json({ available: true });
    if (path.endsWith("/draft")) return Response.json(configRead().draft);
    if (path.endsWith("/versions")) return Response.json(configRead().versions);
    if (path.includes("/versions/")) return Response.json(publishedConfig(Number(path.split("/").at(-1))));
    if (path.endsWith("/catalogue")) return Response.json(configRead().catalogue);
    if (path.endsWith("/runtime")) return Response.json(configRead().runtime);
    return new Response('<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(server.url.href + "#/oakridge/grading-config");
    await page.getByLabel("Question text", { exact: true }).waitFor();
    if (direction !== "shell") {
      await page.getByRole("button", { name: "Version 1", exact: true }).click();
      await page.getByText("Published version 1 · read-only").waitFor();
      if (direction === "back") await page.getByRole("button", { name: "Latest and draft", exact: true }).click();
      else await page.goBack();
    }
    await page.getByLabel("Question text", { exact: true }).fill("Keep this unsaved question");
    const dismissed = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
    if (direction === "shell") await page.getByRole("button", { name: "Runs", exact: true }).click();
    else await page.evaluate((direction) => direction === "back" ? history.back() : history.forward(), direction);
    await dismissed;
    await page.waitForFunction(() => location.hash === "#/oakridge/grading-config");
    expect(await page.getByLabel("Question text", { exact: true }).inputValue()).toBe("Keep this unsaved question");
    expect(await page.getByTestId("grading-draft-status").innerText()).toBe("Unsaved local edits");
    expect(errors).toEqual([]);
  } finally { await context.close(); server.stop(true); }
}, 30_000);
