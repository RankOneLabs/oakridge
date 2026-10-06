import { CORE_MAX_FRAME_BYTES, CORE_MAX_RESPONSE_BYTES, CORE_PROTOCOL_VERSION, decodeCoreResponse, hasSafeWireNumbers, type CoreRequest, type CoreResponseResult, type CoreTransportKind, type DefinitionBundle, type Output } from "./generated-contracts";
import { transportFailure, type CoreResult } from "./transport-errors";
interface Pending { readonly resolve: (result: CoreResult<Output>) => void; readonly timeout: ReturnType<typeof setTimeout> }
type RequestInput<O extends CoreRequest["operation"]> = Extract<CoreRequest, { readonly operation: O }>["input"];
type ClientInput<O extends CoreRequest["operation"]> = O extends "compile"
  ? { readonly bundle: DefinitionBundle; readonly available_operations?: readonly DefinitionBundle["operations"][number][] }
  : Omit<RequestInput<O>, "bundle_digest"> & { readonly bundle: DefinitionBundle; readonly available_operations?: readonly DefinitionBundle["operations"][number][] };
export interface CoreClientOptions { readonly binary: string; readonly args?: readonly string[]; readonly deadlineMs: number; readonly maxPendingRequests?: number }
const MAX_FRAME_BYTES = CORE_MAX_FRAME_BYTES;
const MAX_RESPONSE_BYTES = CORE_MAX_RESPONSE_BYTES;
const MAX_DIGEST_ENTRIES = 64;
function resultFromResponse(result: CoreResponseResult): CoreResult<Output> {
  switch (result.status) {
    case "ok": return { ok: true, value: result.value };
    case "domain_error": return { ok: false, error: { kind: "domain", detail: result.value } };
    case "transport_error": return { ok: false, error: { kind: "transport", detail: result.value } };
  }
}
/** One bounded persistent process; poisoning a transport fails every in-flight request. */
export class CoreClient {
  private readonly process: ReturnType<typeof Bun.spawn>;
  private readonly pending = new Map<string, Pending>();
  private readonly digests = new Map<string, string>();
  private readonly compiling = new Map<string, Promise<CoreResult<Output>>>();
  private readonly deadlineMs: number;
  private readonly maxPendingRequests: number;
  private nextId = 0;
  private terminated = false;
  private digestFor(key: string): string | undefined {
    const digest = this.digests.get(key);
    if (digest) { this.digests.delete(key); this.digests.set(key, digest); }
    return digest;
  }
  private rememberDigest(key: string, digest: string): void {
    this.digests.delete(key);
    this.digests.set(key, digest);
    if (this.digests.size > MAX_DIGEST_ENTRIES) this.digests.delete(this.digests.keys().next().value!);
  }
  static start(options: CoreClientOptions): CoreResult<CoreClient> {
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0
      || (options.maxPendingRequests !== undefined && (!Number.isInteger(options.maxPendingRequests) || options.maxPendingRequests <= 0)))
      return transportFailure("malformed_frame", "positive finite client deadline and queue bound required");
    try { return { ok: true, value: new CoreClient(options) }; }
    catch (error) { return transportFailure("terminated_child", String(error)); }
  }
  private constructor(options: CoreClientOptions) {
    this.deadlineMs = options.deadlineMs;
    this.maxPendingRequests = options.maxPendingRequests ?? 64;
    this.process = Bun.spawn({ cmd: [options.binary, ...(options.args ?? [])], stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    void this.readResponses();
    void this.process.exited.then(() => { this.terminated = true; this.failAll("terminated_child", "core child exited"); });
  }
  private failAll(kind: CoreTransportKind, detail: string): void {
    for (const [id, pending] of this.pending) { clearTimeout(pending.timeout); pending.resolve(transportFailure(kind, detail)); this.pending.delete(id); }
  }
  private poison(kind: CoreTransportKind, detail: string): void {
    this.terminated = true;
    this.failAll(kind, detail);
    this.process.kill();
  }
  private acceptLine(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { this.poison("malformed_frame", "invalid JSON response"); return; }
    const response = decodeCoreResponse(raw);
    if (!response || response.version !== CORE_PROTOCOL_VERSION) { this.poison("malformed_frame", "response failed generated wire schema"); return; }
    const pending = this.pending.get(response.request_id);
    if (!pending) { this.poison("mismatched_request_id", response.request_id); return; }
    this.pending.delete(response.request_id);
    clearTimeout(pending.timeout);
    pending.resolve(resultFromResponse(response.result));
  }
  private async readResponses(): Promise<void> {
    const stdout = this.process.stdout;
    if (!stdout || typeof stdout === "number") { this.poison("terminated_child", "child stdout unavailable"); return; }
    const reader = stdout.getReader();
    let frame: number[] = [];
    try {
      while (!this.terminated) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const byte of value) {
          if (byte === 10) {
            let line: string;
            try { line = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(frame)); }
            catch { this.poison("malformed_frame", "response is not UTF-8"); return; }
            frame = [];
            this.acceptLine(line);
            if (this.terminated) return;
          } else {
            if (frame.length === MAX_RESPONSE_BYTES) { this.poison("oversized_payload", "response frame exceeded maximum bytes"); return; }
            frame.push(byte);
          }
        }
      }
      if (frame.length) this.poison("malformed_frame", "unterminated response frame");
      else if (this.pending.size) this.poison("terminated_child", "child stdout ended");
    } catch (error) { this.poison("terminated_child", String(error)); }
  }
  async request<O extends CoreRequest["operation"]>(operation: O, input: ClientInput<O>): Promise<CoreResult<Output>> {
    const bundle = input.bundle;
    // Same boundary as `send`: a BigInt or cycle in the bundle is a typed transport failure, not a rejection.
    let cacheKey: string;
    try { cacheKey = JSON.stringify(bundle); }
    catch (cause) { return transportFailure("malformed_frame", String(cause)); }
    if (operation === "compile") return this.compileBundle(bundle, cacheKey);
    let digest = this.digestFor(cacheKey);
    if (!digest) {
      const compiled = await this.compileBundle(bundle, cacheKey);
      if (!compiled.ok) return compiled;
      digest = this.digestFor(cacheKey);
    }
    if (!digest) return transportFailure("malformed_frame", "compile did not return a digest");
    const { bundle: _bundle, available_operations: _available, ...rest } = input;
    let result = await this.send(operation, { ...rest, bundle_digest: digest } as unknown as RequestInput<O>);
    if (!result.ok && result.error.kind === "domain" && result.error.detail.kind === "unknown_bundle") {
      const compiled = await this.compileBundle(bundle, cacheKey);
      if (!compiled.ok) return compiled;
      const refreshed = this.digestFor(cacheKey);
      if (!refreshed) return transportFailure("malformed_frame", "compile did not return a digest");
      result = await this.send(operation, { ...rest, bundle_digest: refreshed } as unknown as RequestInput<O>);
    }
    return result;
  }
  private async compileBundle(bundle: DefinitionBundle, cacheKey: string): Promise<CoreResult<Output>> {
    const existing = this.compiling.get(cacheKey);
    if (existing) return existing;
    const task = this.send("compile", { bundle }).then((result) => {
      if (result.ok && result.value.kind === "compiled") this.rememberDigest(cacheKey, result.value.value.digest);
      return result;
    }).finally(() => { this.compiling.delete(cacheKey); });
    this.compiling.set(cacheKey, task);
    return task;
  }
  private async send<O extends CoreRequest["operation"]>(operation: O, input: RequestInput<O>): Promise<CoreResult<Output>> {
    if (this.terminated) return transportFailure("terminated_child", "core child exited");
    if (this.pending.size >= this.maxPendingRequests) return transportFailure("queue_full", "core request queue is full");
    const request_id = String(++this.nextId);
    let frame: string;
    try {
      if (!hasSafeWireNumbers(input)) return transportFailure("malformed_frame", "request numbers exceed JavaScript-safe wire range");
      frame = JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id, operation, input }) + "\n";
    }
    catch (cause) { return transportFailure("malformed_frame", String(cause)); }
    if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES) return transportFailure("oversized_payload", "request frame exceeds maximum bytes");
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.poison("unresponsive_child", "core deadline exceeded"), this.deadlineMs);
      this.pending.set(request_id, { resolve, timeout });
      void this.writeFrame(frame);
    });
  }
  private async writeFrame(frame: string): Promise<void> {
    try {
      const stdin = this.process.stdin;
      if (!stdin || typeof stdin === "number") { this.poison("terminated_child", "child stdin unavailable"); return; }
      stdin.write(frame);
      await stdin.flush();
    } catch (cause) { this.poison("terminated_child", String(cause)); }
  }
  close(): void { this.poison("terminated_child", "core client closed"); }
}
