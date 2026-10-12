import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_PROTOCOL_VERSION, decodeCoreResponse, hasSafeWireNumbers } from "./core-types";
import type { CoreDomainError, CoreRequest, CoreTransportError, Output } from "./core-types";

export const CORE_WASM_PATH = process.env.OAKRIDGE_CORE_WASM ?? resolve(import.meta.dir, "../../../workflow-core/target/wasm32-unknown-unknown/debug/workflow_evaluator.wasm");
export const MAX_SNAPSHOT_BYTES = 64 * 1_048_576;

export type CoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly kind: "domain"; readonly detail: CoreDomainError }
      | { readonly kind: "transport"; readonly detail: CoreTransportError } };
export interface CoreClientOptions { readonly wasm_path?: string }
export interface CoreChildHealth { readonly pid: null; readonly uptime_ms: number; readonly restart_count: 0; readonly last_stderr_lines: readonly string[] }
type RequestInput<O extends CoreRequest["operation"]> = Extract<CoreRequest, { readonly operation: O }>["input"];
interface CoreWasmExports {
  readonly memory: WebAssembly.Memory;
  core_alloc(length: number): number;
  core_dealloc(pointer: number, length: number): void;
  core_process(pointer: number, length: number): number;
  core_response_len(): number;
}

function transport(kind: CoreTransportError["kind"], detail: string): CoreResult<never> {
  return { ok: false, error: { kind: "transport", detail: { kind, detail } } };
}

/** One synchronous WebAssembly instance keeps the compiled-workflow cache in process. */
export class CoreClient {
  private readonly core: CoreWasmExports;
  private readonly startedAt = Date.now();
  private nextId = 0;
  private closed = false;

  private constructor(wasm_path: string) {
    const bytes = new Uint8Array(readFileSync(wasm_path));
    const module = new WebAssembly.Module(bytes);
    this.core = new WebAssembly.Instance(module, {}).exports as unknown as CoreWasmExports;
  }

  static start(options: CoreClientOptions = {}): CoreResult<CoreClient> {
    try { return { ok: true, value: new CoreClient(options.wasm_path ?? CORE_WASM_PATH) }; }
    catch (cause) { return transport("malformed_request", `failed to load core WASM: ${String(cause)}`); }
  }

  get health(): CoreChildHealth {
    return { pid: null, uptime_ms: Date.now() - this.startedAt, restart_count: 0, last_stderr_lines: [] };
  }

  async request<O extends CoreRequest["operation"]>(operation: O, input: RequestInput<O>): Promise<CoreResult<Output>> {
    if (this.closed) return transport("malformed_request", "core client closed");
    if (!hasSafeWireNumbers(input)) return transport("malformed_request", "request numbers exceed JavaScript-safe range");
    let encoded: Uint8Array;
    try {
      if (operation === "step") {
        const snapshot = (input as RequestInput<"step">).snapshot;
        const bytes = Buffer.byteLength(JSON.stringify(snapshot));
        if (bytes > MAX_SNAPSHOT_BYTES) return transport("oversized_payload", `snapshot is ${bytes} bytes; limit is ${MAX_SNAPSHOT_BYTES} bytes`);
      }
      encoded = new TextEncoder().encode(JSON.stringify({ version: CORE_PROTOCOL_VERSION,
        request_id: String(++this.nextId), operation, input }));
    } catch (cause) { return transport("malformed_request", String(cause)); }
    const pointer = this.core.core_alloc(encoded.length);
    try {
      new Uint8Array(this.core.memory.buffer, pointer, encoded.length).set(encoded);
      const responsePointer = this.core.core_process(pointer, encoded.length);
      const responseBytes = new Uint8Array(this.core.memory.buffer, responsePointer, this.core.core_response_len()).slice();
      const response = decodeCoreResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)));
      if (!response || response.version !== CORE_PROTOCOL_VERSION) return transport("malformed_request", "core returned an invalid response");
      switch (response.result.status) {
        case "ok": return { ok: true, value: response.result.value };
        case "domain_error": return { ok: false, error: { kind: "domain", detail: response.result.value } };
        case "transport_error": return { ok: false, error: { kind: "transport", detail: response.result.value } };
      }
    } catch (cause) { return transport("malformed_request", `core invocation failed: ${String(cause)}`); }
    finally { this.core.core_dealloc(pointer, encoded.length); }
  }

  close(): void { this.closed = true; }
}
