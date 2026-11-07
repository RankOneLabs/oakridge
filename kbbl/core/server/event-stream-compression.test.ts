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
import { acceptsGzip, compressEventStream, gzipEventStream } from "./event-stream-compression";

const encode = (text: string) => new TextEncoder().encode(text);
const concat = (chunks: readonly Uint8Array[]) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
/** The stream carries no trailer, so decode what has arrived as a truncated gzip. */
const decodeSoFar = (chunks: readonly Uint8Array[]) =>
  chunks.length === 0 ? "" : gunzipSync(concat(chunks), { finishFlush: constants.Z_SYNC_FLUSH }).toString();
const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> => {
  const { value } = await reader.read();
  if (value === undefined) throw new Error("stream ended before the next chunk");
  return value;
};
const bodyOf = (response: Response): ReadableStream<Uint8Array> => {
  if (response.body === null) throw new Error("response has no body");
  return response.body;
};

describe("acceptsGzip", () => {
  test("accepts gzip listed without a weight", () => {
    expect(acceptsGzip("br, gzip")).toBe(true);
  });

  test("accepts gzip listed with a non-zero weight", () => {
    expect(acceptsGzip("gzip; q=0.5")).toBe(true);
  });

  test("refuses gzip listed with a zero weight", () => {
    expect(acceptsGzip("gzip;q=0")).toBe(false);
  });

  test("refuses when gzip is not listed", () => {
    expect(acceptsGzip("br, deflate")).toBe(false);
  });

  test("refuses when the header is absent", () => {
    expect(acceptsGzip(undefined)).toBe(false);
  });
});

describe("gzipEventStream", () => {
  test("each write decodes as soon as it arrives", async () => {
    const stream = gzipEventStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [await readChunk(reader)];

    void writer.write(encode("data: first\n\n"));
    chunks.push(await readChunk(reader));
    expect(decodeSoFar(chunks)).toBe("data: first\n\n");

    void writer.write(encode("data: second\n\n"));
    chunks.push(await readChunk(reader));
    expect(decodeSoFar(chunks)).toBe("data: first\n\ndata: second\n\n");
  });

  test("a large repetitive frame compresses", async () => {
    const stream = gzipEventStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    await reader.read();
    const frame = encode(`data: ${'{"status":"ended"},'.repeat(10_000)}\n\n`);
    void writer.write(frame);
    expect((await readChunk(reader)).length).toBeLessThan(frame.length / 10);
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
    await bodyOf(response).cancel();
  });

  test("leaves the stream plain for a client that refuses gzip", async () => {
    const response = await app.request("/live", { headers: { "accept-encoding": "gzip;q=0" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    await bodyOf(response).cancel();
  });

  test("a client that disconnects still reaches the stream's abort handler", async () => {
    wasCancelled = false;
    const response = await app.request("/live", { headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const reader = bodyOf(response).getReader();
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
    const reader = bodyOf(response).getReader();
    const chunks: Uint8Array[] = [];
    while (!decodeSoFar(chunks).includes("snapshot")) chunks.push(await readChunk(reader));
    expect(decodeSoFar(chunks)).toContain("event: live");
    await reader.cancel();
  } finally {
    controller.abort();
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
