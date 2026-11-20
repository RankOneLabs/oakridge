import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch, transcriptItemId, transcriptSeq, type AgentMessageItem } from "../../core/acp/transcript-model";
import type { SessionEpochFrame, SessionWireFrame } from "../../core/acp/session-wire";
import { selectItemPage, type ItemPage } from "../../core/acp/transcript-page";
import type { LiveStreamFrame } from "../../core/live-stream";

let browser: Browser;
let script: string;
const css = Bun.file(new URL("../../core/pwa/styles.css", import.meta.url));

beforeAll(async () => {
  const result = await Bun.build({ entrypoints: [`${import.meta.dir}/session-thread-entry.tsx`], target: "browser" });
  if (!result.success || !result.outputs[0]) throw new Error(result.logs.join("\n"));
  script = await result.outputs[0].text();
  browser = await chromium.launch({ args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => { await browser?.close(); });

function agentItem(number: number): AgentMessageItem {
  const seq = transcriptSeq(number);
  return { kind: "agent_message", id: transcriptItemId(seq), seq, message_id: null,
    text: `Message ${number}`, is_replayed: false, is_streaming: false };
}

const items = Array.from({ length: 450 }, (_, index) => agentItem(index + 1));
const epoch = streamEpoch("paging-epoch");
const encoder = new TextEncoder();

function encodeFrame(frame: SessionWireFrame): Uint8Array {
  const envelope: LiveStreamFrame = { topic: "/sessions/paging/stream",
    frame: { event: frame.kind, data: JSON.stringify(frame) } };
  return encoder.encode(`event: live\ndata: ${JSON.stringify(envelope)}\n\n`);
}

function serveThread({ hasEarlier, isTruncated }: { hasEarlier: boolean; isTruncated: boolean }) {
  const requests: number[] = [];
  let pageRequested = Promise.withResolvers<void>();
  const state: { live?: ReadableStreamDefaultController<Uint8Array>; releasePage?: (response?: Response) => void } = {};
  const initial: SessionEpochFrame = {
    kind: "epoch", stream_epoch: epoch, history_kind: "transcript", expired: false, summary: null,
    session_state: EMPTY_SESSION_LIVE_STATE, open_turns: [], items: items.slice(-200),
    has_earlier: hasEarlier, is_truncated: isTruncated,
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
    if (url.pathname === "/live") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { state.live = controller; controller.enqueue(encodeFrame(initial)); },
        cancel() { state.live = undefined; },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/sessions/paging/items") {
      const before_seq = Number(url.searchParams.get("before_seq"));
      requests.push(before_seq);
      const response = await new Promise<Response | undefined>((resolve) => {
        state.releasePage = resolve;
        pageRequested.resolve();
        pageRequested = Promise.withResolvers<void>();
      });
      if (response) return response;
      const page: ItemPage = { kind: "page", stream_epoch: epoch, ...selectItemPage({ items, before_seq, limit: 100 }) };
      return Response.json(page);
    }
    if (url.pathname !== "/") return new Response(null, { status: 404 });
    return new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script type="module" src="/entry.js"></script>',
      { headers: { "content-type": "text/html" } });
  } });
  return {
    server, requests,
    emitItem: (number: number) => state.live?.enqueue(encodeFrame({ kind: "item", item: agentItem(number) })),
    waitForPageRequest: async (count: number) => {
      while (requests.length < count) await pageRequested.promise;
    },
    releasePage: (response?: Response) => state.releasePage?.(response),
    closeStream: () => state.live?.close(),
  };
}

async function waitForVisibleRow(page: Page, number: number) {
  await page.waitForFunction((id) => {
    const row = document.querySelector(`[data-item-id="${id}"]`);
    const viewport = row?.closest(".session-thread__viewport");
    if (!row || !viewport) return false;
    const item = row.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return item.bottom > bounds.top && item.top < bounds.bottom;
  }, transcriptItemId(transcriptSeq(number)));
}

async function firstVisible(viewport: Locator) {
  return viewport.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (const row of Array.from(element.querySelectorAll<HTMLElement>("[data-item-id]"))) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) return { id: row.dataset.itemId, top: rect.top };
    }
    throw new Error("no visible transcript row");
  });
}

test("follows live output and anchors the visible row when older history is prepended", async () => {
  const fixture = serveThread({ hasEarlier: true, isTruncated: false });
  const page = await browser.newPage({ viewport: { width: 430, height: 820 } });
  try {
    await page.goto(`${fixture.server.url.href}#session/paging`);
    await page.getByText("idle", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Show conversation" }).click();
    const viewport = page.locator(".session-thread__viewport");
    await waitForVisibleRow(page, 450);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(820);

    fixture.emitItem(451);
    await waitForVisibleRow(page, 451);

    // Measure at the position where the reader requests history, after the
    // intentional jump to the sentinel and before the network page is released.
    await viewport.evaluate((element) => { element.scrollTop = 0; });
    await viewport.getByText("Loading earlier history…").waitFor();
    await fixture.waitForPageRequest(1);
    const anchor = await firstVisible(viewport);
    await viewport.evaluate(async (element) => {
      element.scrollTop = 300;
      await new Promise(requestAnimationFrame);
      element.scrollTop = 0;
      await new Promise(requestAnimationFrame);
    });
    expect(fixture.requests).toEqual([251]);
    // A live item older than the page changes the first ID during the request
    // and leaves that ID unchanged when the page itself renders.
    fixture.emitItem(101);
    await viewport.getByText("Message 101", { exact: true }).waitFor({ state: "attached" });
    fixture.releasePage();

    await viewport.getByText("Message 151", { exact: true }).waitFor({ state: "attached" });
    await page.waitForFunction(({ id, top }) => {
      const row = document.querySelector(`[data-item-id="${id}"]`);
      return row !== null && Math.abs(row.getBoundingClientRect().top - top) <= 2;
    }, anchor);
    expect(fixture.requests).toEqual([251]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    fixture.releasePage();
    fixture.closeStream();
    await page.close();
    fixture.server.stop(true);
  }
}, 30_000);

test("offers a retry after a failed history request while the sentinel stays visible", async () => {
  const fixture = serveThread({ hasEarlier: true, isTruncated: false });
  const page = await browser.newPage();
  try {
    await page.goto(fixture.server.url.href);
    await page.getByText("idle", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Show conversation" }).click();
    const viewport = page.locator(".session-thread__viewport");
    await waitForVisibleRow(page, 450);
    await viewport.evaluate((element) => { element.scrollTop = 0; });
    await viewport.getByText("Loading earlier history…").waitFor();
    await fixture.waitForPageRequest(1);
    fixture.releasePage(Response.json({ error: "Temporary failure" }, { status: 503 }));
    const feedback = viewport.getByRole("alert").filter({ hasText: "Temporary failure" });
    await feedback.waitFor();
    expect(fixture.requests).toEqual([251]);

    await feedback.getByRole("button", { name: "Retry" }).click();
    await feedback.getByRole("button", { name: "Retrying…" }).waitFor();
    await fixture.waitForPageRequest(2);
    expect(fixture.requests).toEqual([251, 251]);
    fixture.releasePage();
    await viewport.getByText("Message 151", { exact: true }).waitFor({ state: "attached" });
    await feedback.waitFor({ state: "detached" });
    expect(fixture.requests).toEqual([251, 251]);
  } finally {
    fixture.releasePage();
    fixture.closeStream();
    await page.close();
    fixture.server.stop(true);
  }
}, 30_000);

test("shows the truncation notice when the server has no earlier items", async () => {
  const fixture = serveThread({ hasEarlier: false, isTruncated: true });
  const page = await browser.newPage();
  try {
    await page.goto(fixture.server.url.href);
    await page.getByText("idle", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Show conversation" }).click();
    const viewport = page.locator(".session-thread__viewport");
    await viewport.getByText("Older history is no longer held").waitFor({ state: "attached" });
    expect(await viewport.locator(".session-thread__sentinel").count()).toBe(0);
    expect(fixture.requests).toEqual([]);
  } finally {
    fixture.closeStream();
    await page.close();
    fixture.server.stop(true);
  }
}, 30_000);
