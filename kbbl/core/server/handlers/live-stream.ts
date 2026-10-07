import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
  createSseDecoderState,
  decodeSseChunk,
  type LiveStreamFrame,
  type LiveStreamTopic,
} from "../../live-stream";
import { isValidSid } from "./acp-per-sid";

type TopicsResult =
  | { ok: true; topics: LiveStreamTopic[] }
  | { ok: false; error: string };

export function parseLiveStreamTopics(values: readonly string[]): TopicsResult {
  if (values.length === 0) return { ok: false, error: "at least one topic is required" };
  const topics = new Set<LiveStreamTopic>();
  for (const value of values) {
    if (value === "/inbox" || value === "/oakridge/api/events") {
      topics.add(value);
      continue;
    }
    const match = /^\/sessions\/([^/]+)\/stream$/.exec(value);
    if (!match || !isValidSid(match[1])) {
      return { ok: false, error: `invalid live stream topic: ${value}` };
    }
    topics.add(value as LiveStreamTopic);
  }
  return { ok: true, topics: [...topics] };
}

interface RelayInput {
  app: Hono;
  request: Request;
  topic: LiveStreamTopic;
  signal: AbortSignal;
  emit: (frame: LiveStreamFrame) => Promise<void>;
}

/** Reuse the existing handlers in-process: no extra browser or local TCP
 * connections, and ACP retains ownership of replay and history leases. */
async function relayTopic({ app, request, topic, signal, emit }: RelayInput): Promise<void> {
  while (!signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    try {
      const headers = new Headers(request.headers);
      // A cursor belongs to one upstream stream, never to the combined feed.
      headers.delete("last-event-id");
      const response = await app.fetch(new Request(new URL(topic, request.url), { headers, signal }));
      if (signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || !response.body) {
        const detail = await response.text();
        console.warn(`live stream: topic=${topic} rejected status=${response.status} detail=${detail}`);
        await emit({ topic, frame: { event: "stream_error", data: detail || JSON.stringify({ error: `stream unavailable (${response.status})` }) } });
        if (response.status === 400 || response.status === 404) return;
      } else {
        reader = response.body.getReader();
        signal.addEventListener("abort", cancelReader, { once: true });
        if (signal.aborted) cancelReader();
        const decoder = new TextDecoder();
        let state = createSseDecoderState();
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const decoded = decodeSseChunk(state, decoder.decode(chunk.value, { stream: true }));
          state = decoded.state;
          for (const frame of decoded.frames) await emit({ topic, frame });
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`live stream: topic=${topic} disconnected detail=${detail}`);
      await emit({ topic, frame: { event: "stream_error", data: JSON.stringify({ error: detail }) } });
    } finally {
      signal.removeEventListener("abort", cancelReader);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
    if (!signal.aborted) {
      // A failed upstream must not reconnect the healthy session channels.
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 1000);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}

export function mountLiveStreamRoutes(app: Hono): void {
  app.get("/live", (c) => {
    const parsed = parseLiveStreamTopics(c.req.queries("topic") ?? []);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      if (c.req.raw.signal.aborted) stop();
      await stream.write(": ready\n\n");
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(stop); }, 15_000);
      try {
        await Promise.all(parsed.topics.map((topic) => relayTopic({
          app, request: c.req.raw, topic, signal: controller.signal,
          emit: async (frame) => {
            try {
              await stream.writeSSE({ event: "live", data: JSON.stringify(frame) });
            } catch (error) {
              stop();
              throw error;
            }
          },
        })));
      } finally {
        stop();
        clearInterval(heartbeat);
        c.req.raw.signal.removeEventListener("abort", stop);
      }
    });
  });
}
