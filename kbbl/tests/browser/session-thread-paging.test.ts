import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, expect as expectPage, type Browser, type Locator } from "@playwright/test";
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
  const state: { live?: ReadableStreamDefaultController<Uint8Array>; releasePage?: () => void } = {};
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
      await new Promise<void>((resolve) => { state.releasePage = resolve; });
      const page: ItemPage = { kind: "page", stream_epoch: epoch, ...selectItemPage({ items, before_seq, limit: 100 }) };
      return Response.json(page);
    }
    if (url.pathname !== "/") return new Response(null, { status: 404 });
    return new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="app"></div><script type="module" src="/entry.js"></script>',
      { headers: { "content-type": "text/html" } });
  } });
  return {
    server, requests,
    append: () => state.live?.enqueue(encodeFrame({ kind: "item", item: agentItem(451) })),
    releasePage: () => state.releasePage?.(),
  };
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
    await expectPage(viewport.getByText("Message 450", { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(820);

    fixture.append();
    await expectPage(viewport.getByText("Message 451", { exact: true })).toBeInViewport();

    // Measure at the position where the reader requests history, after the
    // intentional jump to the sentinel and before the network page is released.
    await viewport.evaluate((element) => { element.scrollTop = 0; });
    await viewport.getByText("Loading earlier history…").waitFor();
    const anchor = await firstVisible(viewport);
    await viewport.evaluate(async (element) => {
      element.scrollTop = 300;
      await new Promise(requestAnimationFrame);
      element.scrollTop = 0;
      await new Promise(requestAnimationFrame);
    });
    expect(fixture.requests).toEqual([251]);
    fixture.releasePage();

    await viewport.getByText("Message 151", { exact: true }).waitFor({ state: "attached" });
    const row = viewport.locator(`[data-item-id="${anchor.id}"]`);
    await expectPage.poll(async () => Math.abs(((await row.boundingBox())?.y ?? Infinity) - anchor.top)).toBeLessThanOrEqual(2);
    expect(fixture.requests).toEqual([251]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    fixture.releasePage();
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
    await page.close();
    fixture.server.stop(true);
  }
}, 30_000);
