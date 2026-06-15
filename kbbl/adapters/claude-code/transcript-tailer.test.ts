import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTranscriptTailer, type TailerHandle } from "./transcript-tailer";

interface Emitted {
  type: string;
  payload: unknown;
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const line = (obj: unknown): string => JSON.stringify(obj) + "\n";

describe("startTranscriptTailer", () => {
  let dir: string;
  let path: string;
  let emitted: Emitted[];
  let controller: AbortController;
  let handle: TailerHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kbbl-tailer-"));
    path = join(dir, "transcript.jsonl");
    emitted = [];
    controller = new AbortController();
    handle = null;
  });

  afterEach(() => {
    handle?.dispose();
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = () => {
    handle = startTranscriptTailer({
      path,
      emit: async (type, payload) => {
        emitted.push({ type, payload });
      },
      signal: controller.signal,
      label: "test-sid",
    });
  };

  test("emits events for lines appended after start", async () => {
    writeFileSync(path, "");
    start();
    appendFileSync(
      path,
      line({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }),
    );
    await waitFor(() => emitted.length >= 1);
    expect(emitted[0].type).toBe("user");
  });

  test("emits assistant + result on an end_turn line", async () => {
    writeFileSync(path, "");
    start();
    appendFileSync(
      path,
      line({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    );
    await waitFor(() => emitted.length >= 2);
    expect(emitted.map((e) => e.type)).toEqual(["assistant", "result"]);
  });

  test("buffers a partial line until its newline arrives", async () => {
    writeFileSync(path, "");
    start();
    const full = line({ type: "user", uuid: "u2", message: { role: "user", content: "partial" } });
    const half = full.slice(0, 15);
    const rest = full.slice(15);
    appendFileSync(path, half); // no newline yet
    await new Promise((r) => setTimeout(r, 200));
    expect(emitted).toHaveLength(0);
    appendFileSync(path, rest);
    await waitFor(() => emitted.length >= 1);
    expect(emitted[0].type).toBe("user");
  });

  test("does not re-emit a uuid already seen", async () => {
    writeFileSync(path, "");
    start();
    const dup = line({ type: "user", uuid: "dup", message: { role: "user", content: "x" } });
    appendFileSync(path, dup);
    await waitFor(() => emitted.length >= 1);
    // A file shrink/rewrite that replays the same uuid must not double-emit.
    writeFileSync(path, dup);
    await new Promise((r) => setTimeout(r, 300));
    expect(emitted).toHaveLength(1);
  });

  test("reads a backlog larger than one read chunk in full", async () => {
    // Pre-existing transcript bigger than MAX_READ_CHUNK (64KB), so the drain
    // loop must span multiple chunk reads to catch up.
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(
        line({
          type: "user",
          uuid: `b${i}`,
          // ~200 bytes/line × 400 ≈ 80KB > 64KB chunk.
          message: { role: "user", content: "x".repeat(180) },
        }),
      );
    }
    writeFileSync(path, lines.join(""));
    start();
    await waitFor(() => emitted.length >= 400, 5000);
    expect(emitted).toHaveLength(400);
    expect(emitted.every((e) => e.type === "user")).toBe(true);
  });

  test("parses a line that straddles a chunk boundary", async () => {
    // A single line larger than one chunk: its newline only arrives after
    // several chunk reads, so it must accumulate in `leftover` across them.
    writeFileSync(path, "");
    start();
    const big = line({
      type: "user",
      uuid: "huge",
      message: { role: "user", content: "y".repeat(150_000) },
    });
    appendFileSync(path, big);
    await waitFor(() => emitted.length >= 1, 5000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("user");
  });

  test("stops emitting after dispose", async () => {
    writeFileSync(path, "");
    start();
    appendFileSync(
      path,
      line({ type: "user", uuid: "u3", message: { role: "user", content: "a" } }),
    );
    await waitFor(() => emitted.length >= 1);
    if (!handle) throw new Error("tailer handle not initialized");
    handle.dispose();
    appendFileSync(
      path,
      line({ type: "user", uuid: "u4", message: { role: "user", content: "b" } }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(emitted).toHaveLength(1);
  });
});
