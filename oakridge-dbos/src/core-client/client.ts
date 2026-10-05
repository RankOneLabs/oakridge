import type { CoreRequest, CoreResponse, CoreResponseResult, CoreTransportKind } from "./generated-contracts";
import { transportFailure, type CoreResult } from "./transport-errors";

interface Pending {
  readonly resolve: (result: CoreResult<unknown>) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface CoreClientOptions {
  readonly binary: string;
  readonly deadlineMs: number;
}

const MAX_FRAME_BYTES = 1_048_576;

function isResponse(value: unknown): value is CoreResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CoreResponse>;
  if (candidate.version !== 1 || typeof candidate.request_id !== "string"
    || typeof candidate.truncated !== "boolean" || typeof candidate.result !== "object"
    || candidate.result === null || !("status" in candidate.result)
    || !("value" in candidate.result)) return false;
  const result = candidate.result as { status: unknown; value: unknown };
  if (result.status === "ok") return true;
  if (typeof result.value !== "object" || result.value === null) return false;
  if (result.status === "domain_error") {
    const error = result.value as { operation?: unknown; entity_id?: unknown; kind?: unknown; detail?: unknown };
    return typeof error.operation === "string" && typeof error.entity_id === "string"
      && typeof error.kind === "string" && typeof error.detail === "string";
  }
  if (result.status === "transport_error") {
    const error = result.value as { kind?: unknown; detail?: unknown };
    return typeof error.kind === "string" && typeof error.detail === "string";
  }
  return false;
}

function resultFromResponse(result: CoreResponseResult): CoreResult<unknown> {
  switch (result.status) {
    case "ok": return { ok: true, value: result.value };
    case "domain_error": return { ok: false, error: { kind: "domain", detail: result.value } };
    case "transport_error": return { ok: false, error: { kind: "transport", detail: result.value } };
  }
}

export class CoreClient {
  private readonly process: ReturnType<typeof Bun.spawn>;
  private readonly pending = new Map<string, Pending>();
  private readonly deadlineMs: number;
  private nextId = 0;
  private terminated = false;

  static start(options: CoreClientOptions): CoreResult<CoreClient> {
    try { return { ok: true, value: new CoreClient(options) }; }
    catch (error) { return transportFailure("terminated_child", String(error)); }
  }

  private constructor(options: CoreClientOptions) {
    this.deadlineMs = options.deadlineMs;
    this.process = Bun.spawn({ cmd: [options.binary], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.readResponses();
    void this.process.exited.then(() => {
      this.terminated = true;
      this.failAll("terminated_child", "core child exited");
    });
  }

  private failAll(kind: CoreTransportKind, detail: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve(transportFailure(kind, detail));
      this.pending.delete(id);
    }
  }

  private acceptLine(line: string): void {
    if (new TextEncoder().encode(line).length > MAX_FRAME_BYTES) {
      this.failAll("oversized_payload", "response frame exceeded maximum bytes");
      return;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(line); }
    catch { this.failAll("malformed_frame", "invalid JSON response"); return; }
    if (!isResponse(decoded)) { this.failAll("malformed_frame", "invalid response envelope"); return; }
    const pending = this.pending.get(decoded.request_id);
    if (!pending) { this.failAll("mismatched_request_id", decoded.request_id); return; }
    this.pending.delete(decoded.request_id);
    clearTimeout(pending.timeout);
    pending.resolve(resultFromResponse(decoded.result));
  }

  private async readResponses(): Promise<void> {
    const stdout = this.process.stdout;
    if (!stdout || typeof stdout === "number") {
      this.failAll("terminated_child", "child stdout unavailable");
      return;
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_FRAME_BYTES) {
          this.failAll("oversized_payload", "response frame exceeded maximum bytes");
          buffer = "";
          continue;
        }
        let end = buffer.indexOf("\n");
        while (end !== -1) {
          this.acceptLine(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          end = buffer.indexOf("\n");
        }
      }
      if (buffer.length) this.failAll("malformed_frame", "unterminated response frame");
    } catch (error) {
      this.failAll("terminated_child", String(error));
    }
  }

  async request(operation: CoreRequest["operation"], input: unknown): Promise<CoreResult<unknown>> {
    if (this.terminated) return transportFailure("terminated_child", "core child exited");
    const request_id = String(++this.nextId);
    const request: CoreRequest = { version: 1, request_id, operation, input };
    const frame = JSON.stringify(request) + "\n";
    if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES) return transportFailure("oversized_payload", "request frame exceeds maximum bytes");
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request_id);
        resolve(transportFailure("unresponsive_child", "core deadline exceeded"));
      }, this.deadlineMs);
      this.pending.set(request_id, { resolve, timeout });
      try {
        const stdin = this.process.stdin;
        if (!stdin || typeof stdin === "number") throw new Error("child stdin unavailable");
        void stdin.write(frame);
        void stdin.flush();
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(request_id);
        resolve(transportFailure("terminated_child", String(error)));
      }
    });
  }

  close(): void { this.process.kill(); }
}
