import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { chromium, type Browser } from "@playwright/test";

import { compressEventStream } from "../../core/server/event-stream-compression";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const app = new Hono();
  app.use("/live", compressEventStream);
  app.get("/live", (c) => streamSSE(c, async (stream) => {
    await stream.write(": ready\n\n");
    await stream.writeSSE({ event: "live", data: "first" });
    await new Promise<void>((resolve) => { setTimeout(resolve, 300); });
    await stream.writeSSE({ event: "live", data: "second" });
    await new Promise<void>((resolve) => { stream.onAbort(resolve); });
  }));
  app.get("/", (c) => c.html("<!doctype html>"));
  server = Bun.serve({ port: 0, fetch: app.fetch });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

test("EventSource receives each gzip frame while the stream stays open", async () => {
  const page = await browser.newPage();
  await page.goto(new URL("/", server.url).href);
  const frames = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const received: string[] = [];
    const source = new EventSource("/live");
    source.addEventListener("live", (event) => {
      received.push((event as MessageEvent<string>).data);
      if (received.length === 2) { source.close(); resolve(received); }
    });
    source.onerror = () => reject(new Error("event stream failed"));
  }));
  expect(frames).toEqual(["first", "second"]);
  await page.close();
}, 15_000);
