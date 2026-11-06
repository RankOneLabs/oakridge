import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, gunzipSync } from "node:zlib";

import { makeAcpTestService } from "../acp/test-harness";
import { KbblConfigSchema } from "../config";
import { createApp } from "./app";
import { compressEventStream, gzipEventStream } from "./event-stream-compression";

const encode = (text: string) => new TextEncoder().encode(text);
const concat = (chunks: readonly Uint8Array[]) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
/** The stream carries no trailer, so decode what has arrived as a truncated gzip. */
const decodeSoFar = (chunks: readonly Uint8Array[]) =>
  chunks.length === 0 ? "" : gunzipSync(concat(chunks), { finishFlush: constants.Z_SYNC_FLUSH }).toString();

describe("gzipEventStream", () => {
  test("each write decodes as soon as it arrives", async () => {
    const stream = gzipEventStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [(await reader.read()).value!];

    void writer.write(encode("data: first\n\n"));
    chunks.push((await reader.read()).value!);
    expect(decodeSoFar(chunks)).toBe("data: first\n\n");

    void writer.write(encode("data: second\n\n"));
    chunks.push((await reader.read()).value!);
    expect(decodeSoFar(chunks)).toBe("data: first\n\ndata: second\n\n");
  });

  test("a large repetitive frame compresses", async () => {
    const stream = gzipEventStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    await reader.read();
    const frame = encode(`data: ${'{"status":"ended"},'.repeat(10_000)}\n\n`);
    void writer.write(frame);
    expect((await reader.read()).value!.length).toBeLessThan(frame.length / 10);
  });
});

describe("compressEventStream", () => {
  let wasCancelled = false;
  const app = new Hono();
  app.use("/live", compressEventStream);
  app.get("/live", (c) => streamSSE(c, async (stream) => {
    stream.onAbort(() => { wasCancelled = true; });
    await stream.write(": ready\n\n");
    await new Promise<void>((resolve) => { stream.onAbort(resolve); });
  }));

  test("leaves the stream plain for a client that does not accept gzip", async () => {
    const response = await app.request("/live");
    expect(response.headers.get("content-encoding")).toBeNull();
    await response.body!.cancel();
  });

  test("a client that disconnects still reaches the stream's abort handler", async () => {
    wasCancelled = false;
    const response = await app.request("/live", { headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(10);
    expect(wasCancelled).toBe(true);
  });
});

test("the app's /live relays the inbox snapshot through gzip", async () => {
  const root = mkdtempSync(join(tmpdir(), "kbbl-live-gzip-"));
  const { service } = makeAcpTestService({ stateDir: join(root, "state") });
  const controller = new AbortController();
  try {
    const app = createApp({ acp: service, defaultWorkdir: root, pwaDistDir: root, getBunServer: () => null, config: KbblConfigSchema.parse({}) });
    const response = await app.fetch(new Request("http://kbbl.test/live?topic=/inbox", {
      headers: { "accept-encoding": "gzip" }, signal: controller.signal }));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (!decodeSoFar(chunks).includes("snapshot")) chunks.push((await reader.read()).value!);
    expect(decodeSoFar(chunks)).toContain("event: live");
    await reader.cancel();
  } finally {
    controller.abort();
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
