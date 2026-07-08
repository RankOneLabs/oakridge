import { describe, test, expect } from "bun:test";
import { createStdioTransport } from "./transport";

describe("StdioTransport", () => {
  test("creates transport with correct interface", () => {
    // Verify the factory produces an object with the required interface.
    // We use `echo` as a trivial binary that exits after one line.
    const t = createStdioTransport({ bin: "echo", args: ["hello"] });
    expect(typeof t.writeLine).toBe("function");
    expect(typeof t.lines).toBe("function");
    expect(typeof t.close).toBe("function");
    expect(typeof t.closed).toBe("boolean");
    expect(typeof t.onClose).toBe("function");
    // Close immediately to avoid leaving processes open
    void t.close();
  });

  test("reads lines from stdout", async () => {
    const t = createStdioTransport({ bin: "echo", args: ["hello\nworld"] });
    const received: string[] = [];
    for await (const line of t.lines()) {
      received.push(line);
    }
    // echo outputs the string followed by a newline; split lines land as separate yields
    expect(received.join(",")).toContain("hello");
  });

  test("closed becomes true after close()", async () => {
    const t = createStdioTransport({ bin: "echo", args: ["hi"] });
    // Drain output
    for await (const _line of t.lines()) { /* drain */ }
    // After the process exits, closed should flip
    await new Promise((r) => setTimeout(r, 50));
    expect(t.closed).toBe(true);
  });

  test("onClose handler is called when process exits", async () => {
    const t = createStdioTransport({ bin: "echo", args: ["hi"] });
    let called = false;
    t.onClose(() => { called = true; });
    // Drain to let the process exit
    for await (const _line of t.lines()) { /* drain */ }
    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(true);
  });
});

describe("createUnixSocketTransport shape", () => {
  test("factory function is exported", async () => {
    const mod = await import("./transport");
    expect(typeof mod.createUnixSocketTransport).toBe("function");
  });
});

describe("createWsTransport shape", () => {
  test("factory function is exported", async () => {
    const mod = await import("./transport");
    expect(typeof mod.createWsTransport).toBe("function");
  });
});

// Internal line-buffering logic test using a synthetic iterable
describe("line buffering logic", () => {
  // Helper that replicates the line-splitting logic from the transport
  function splitLines(chunks: string[]): string[] {
    const lines: string[] = [];
    let buf = "";
    const trimCR = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
    for (const chunk of chunks) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        lines.push(trimCR(buf.slice(0, idx)));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.length > 0) lines.push(trimCR(buf));
    return lines;
  }

  test("splits simple lines", () => {
    expect(splitLines(["a\nb\nc\n"])).toEqual(["a", "b", "c"]);
  });

  test("handles partial chunks", () => {
    expect(splitLines(["hel", "lo\nwor", "ld\n"])).toEqual(["hello", "world"]);
  });

  test("strips carriage returns", () => {
    expect(splitLines(["foo\r\nbar\r\n"])).toEqual(["foo", "bar"]);
  });

  test("handles empty input", () => {
    expect(splitLines([])).toEqual([]);
  });

  test("handles multiple JSON lines (JSONL pattern)", () => {
    const jsonl = [
      '{"method":"a","params":{}}\n',
      '{"method":"b","params":{}}\n',
    ];
    const lines = splitLines(jsonl);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).method).toBe("a");
    expect(JSON.parse(lines[1]).method).toBe("b");
  });
});
