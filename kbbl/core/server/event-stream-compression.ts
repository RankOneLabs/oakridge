import type { MiddlewareHandler } from "hono";
import { constants, deflateRawSync } from "node:zlib";

const GZIP_HEADER = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff);

/**
 * `CompressionStream` buffers until its input ends, so it would hold back every
 * frame of a stream that never ends. Each write here becomes its own
 * sync-flushed deflate block under one gzip header, which decoders deliver as
 * it arrives. Blocks share no dictionary, so a small frame gains little; the
 * large snapshot and replay frames are what this is for. The stream has no gzip
 * trailer: it only ends when one side drops it, and EventSource reconnects then.
 */
export const gzipEventStream = (): TransformStream<Uint8Array, Uint8Array> =>
  new TransformStream({
    start: (controller) => controller.enqueue(GZIP_HEADER),
    transform: (chunk, controller) => controller.enqueue(deflateRawSync(chunk, { finishFlush: constants.Z_SYNC_FLUSH })),
  });

export const compressEventStream: MiddlewareHandler = async (c, next) => {
  await next();
  const isEventStream = c.res.headers.get("content-type")?.startsWith("text/event-stream") ?? false;
  if (!isEventStream || !c.res.body || !c.req.header("accept-encoding")?.includes("gzip")) return;
  c.res = new Response(c.res.body.pipeThrough(gzipEventStream()), c.res);
  c.res.headers.set("content-encoding", "gzip");
  c.res.headers.append("vary", "accept-encoding");
};
