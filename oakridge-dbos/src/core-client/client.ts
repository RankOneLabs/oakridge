import { CORE_MAX_FRAME_BYTES, CORE_MAX_RESPONSE_BYTES, CORE_PROTOCOL_VERSION, decodeCoreResponse, hasSafeWireNumbers, type CoreRequest, type CoreResponseResult, type CoreTransportKind, type DefinitionBundle, type Output } from "./generated-contracts";
import { transportFailure, type CoreResult } from "./transport-errors";
interface Pending { readonly resolve: (result: CoreResult<Output>) => void; readonly frame: string; timeout: ReturnType<typeof setTimeout> | null }
export interface CoreChildHealth { readonly pid: number | null; readonly uptime_ms: number | null; readonly restart_count: number; readonly last_stderr_lines: readonly string[] }
type RequestInput<O extends CoreRequest["operation"]> = Extract<CoreRequest, { readonly operation: O }>["input"];
/** Callers hand over the source bundle; the client compiles once, caches the digest and addresses by it. */
type ClientInput<O extends CoreRequest["operation"]> = O extends "compile"
  ? { readonly bundle: DefinitionBundle }
  : Omit<RequestInput<O>, "bundle_digest"> & { readonly bundle: DefinitionBundle };
export interface CoreClientOptions { readonly binary: string; readonly args?: readonly string[]; readonly deadlineMs: number; /** Maximum in-flight requests; there is no request queue. */ readonly maxPendingRequests?: number }
const MAX_FRAME_BYTES = CORE_MAX_FRAME_BYTES;
const MAX_RESPONSE_BYTES = CORE_MAX_RESPONSE_BYTES;
const MAX_DIGEST_ENTRIES = 64;
const STDERR_RING_BYTES = 16_384;
const MIN_RESTART_INTERVAL_MS = 250;
function resultFromResponse(result: CoreResponseResult): CoreResult<Output> {
  switch (result.status) {
    case "ok": return { ok: true, value: result.value };
    case "domain_error": return { ok: false, error: { kind: "domain", detail: result.value } };
    case "transport_error": return { ok: false, error: { kind: "transport", detail: result.value } };
  }
}
/** One persistent process with bounded in-flight requests and rate-limited replacement. */
export class CoreClient {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private readonly options: CoreClientOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly digests = new Map<string, string>();
  private readonly compiling = new Map<string, Promise<CoreResult<Output>>>();
  private readonly deadlineMs: number;
  private readonly maxPendingRequests: number;
  private nextId = 0;
  private generation = 0;
  private closed = false;
  private restartCount = 0;
  private lastSpawnAt = 0;
  private spawnedAt: number | null = null;
  private stderrBytes = new Uint8Array(0);
  get health(): CoreChildHealth {
    return { pid: this.process?.pid ?? null, uptime_ms: this.spawnedAt === null ? null : Date.now() - this.spawnedAt,
      restart_count: this.restartCount, last_stderr_lines: new TextDecoder().decode(this.stderrBytes).trimEnd().split("\n").filter(Boolean).slice(-20) };
  }
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
      return transportFailure("malformed_frame", "positive finite client deadline and in-flight bound required");
    try { return { ok: true, value: new CoreClient(options) }; }
    catch (error) { return transportFailure("terminated_child", String(error)); }
  }
  private constructor(options: CoreClientOptions) {
    this.options = options;
    this.deadlineMs = options.deadlineMs;
    this.maxPendingRequests = options.maxPendingRequests ?? 64;
    this.spawn();
  }
  private spawn(): void {
    const child = Bun.spawn({ cmd: [this.options.binary, ...(this.options.args ?? [])], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.process = child;
    this.spawnedAt = Date.now();
    this.lastSpawnAt = this.spawnedAt;
    const generation = ++this.generation;
    void this.readStderr(child, generation);
    void this.readResponses(child, generation);
    void child.exited.then(() => {
      if (generation === this.generation && !this.closed) this.fault("terminated_child", "core child exited", generation);
    });
  }
  private async readStderr(child: ReturnType<typeof Bun.spawn>, generation: number): Promise<void> {
    const stderr = child.stderr;
    if (!stderr || typeof stderr === "number") return;
    try {
      const reader = stderr.getReader();
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        if (generation !== this.generation) return;
        const bytes = new Uint8Array(this.stderrBytes.length + chunk.length);
        bytes.set(this.stderrBytes); bytes.set(chunk, this.stderrBytes.length);
        this.stderrBytes = bytes.slice(-STDERR_RING_BYTES);
      }
    } catch { /* Diagnostics must not alter the transport result. */ }
  }
  private settle(id: string, result: CoreResult<Output>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.resolve(result);
  }
  private failureDetail(detail: string): string {
    const stderr = new TextDecoder().decode(this.stderrBytes).trim();
    return stderr ? `${detail}; child stderr: ${stderr}` : detail;
  }
  private fault(kind: CoreTransportKind, detail: string, generation: number): void {
    if (generation !== this.generation || this.closed) return;
    const first = this.pending.keys().next().value;
    if (first) this.settle(first, transportFailure(kind, this.failureDetail(detail)));
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    const child = this.process;
    this.process = null;
    this.spawnedAt = null;
    ++this.generation;
    child?.kill();
    const delay = Math.max(0, MIN_RESTART_INTERVAL_MS - (Date.now() - this.lastSpawnAt));
    void new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => {
      if (this.closed) return;
      try {
        this.spawn();
        this.restartCount++;
        for (const [id, pending] of this.pending) void this.writeFrame(id, pending.frame, this.generation);
      } catch (cause) {
        for (const id of this.pending.keys()) this.settle(id, transportFailure("terminated_child", this.failureDetail(String(cause))));
      }
    });
  }
  private acceptLine(line: string, generation: number): void {
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { this.fault("malformed_frame", "invalid JSON response", generation); return; }
    const response = decodeCoreResponse(raw);
    if (!response || response.version !== CORE_PROTOCOL_VERSION) { this.fault("malformed_frame", "response failed generated wire schema", generation); return; }
    if (!this.pending.has(response.request_id)) { this.fault("mismatched_request_id", response.request_id, generation); return; }
    this.settle(response.request_id, resultFromResponse(response.result));
  }
  private async readResponses(child: ReturnType<typeof Bun.spawn>, generation: number): Promise<void> {
    const stdout = child.stdout;
    if (!stdout || typeof stdout === "number") { this.fault("terminated_child", "child stdout unavailable", generation); return; }
    const reader = stdout.getReader();
    let frame: number[] = [];
    try {
      while (generation === this.generation && !this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const byte of value) {
          if (byte === 10) {
            let line: string;
            try { line = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(frame)); }
            catch { this.fault("malformed_frame", "response is not UTF-8", generation); return; }
            frame = [];
            this.acceptLine(line, generation);
            if (generation !== this.generation) return;
          } else {
            if (frame.length === MAX_RESPONSE_BYTES) { this.fault("oversized_payload", "response frame exceeded maximum bytes", generation); return; }
            frame.push(byte);
          }
        }
      }
      if (generation !== this.generation || this.closed) return;
      this.fault(frame.length ? "malformed_frame" : "terminated_child", frame.length ? "unterminated response frame" : "child stdout ended", generation);
    } catch (error) { this.fault("terminated_child", String(error), generation); }
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
    const { bundle: _bundle, ...rest } = input;
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
    if (this.closed) return transportFailure("terminated_child", "core client closed");
    if (this.pending.size >= this.maxPendingRequests) return transportFailure("queue_full", "core in-flight request bound reached");
    const request_id = String(++this.nextId);
    let frame: string;
    try {
      if (!hasSafeWireNumbers(input)) return transportFailure("malformed_frame", "request numbers exceed JavaScript-safe wire range");
      frame = JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id, operation, input }) + "\n";
    } catch (cause) { return transportFailure("malformed_frame", String(cause)); }
    if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES) return transportFailure("oversized_payload", "request frame exceeds maximum bytes");
    return new Promise((resolve) => {
      this.pending.set(request_id, { resolve, frame, timeout: null });
      if (this.process) void this.writeFrame(request_id, frame, this.generation);
    });
  }
  private async writeFrame(id: string, frame: string, generation: number): Promise<void> {
    try {
      if (generation !== this.generation || !this.pending.has(id)) return;
      const stdin = this.process?.stdin;
      if (!stdin || typeof stdin === "number") { this.fault("terminated_child", "child stdin unavailable", generation); return; }
      stdin.write(frame);
      await stdin.flush();
      // The deadline starts only once the frame has been flushed to the child pipe.
      const pending = this.pending.get(id);
      if (generation === this.generation && pending && !pending.timeout)
        pending.timeout = setTimeout(() => this.fault("unresponsive_child", "core deadline exceeded", generation), this.deadlineMs);
    } catch (cause) { this.fault("terminated_child", String(cause), generation); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    this.process?.kill();
    this.process = null;
    this.spawnedAt = null;
    for (const id of this.pending.keys()) this.settle(id, transportFailure("terminated_child", "core client closed"));
  }
}
