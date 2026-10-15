import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_PROTOCOL_VERSION, decodeCoreResponse, hasSafeWireNumbers } from "./core-types";
import type { CompiledWorkflow, CoreCompileError, CoreDomainError, CoreRequest, CoreTransportError, Output, StepResult, WantedWorker, Workflow } from "./core-types";
import { traced, type Traced } from "../domain/primitives";
import { OPERATION_REGISTRY } from "../operations/registry";

export const CORE_WASM_PATH = process.env.OAKRIDGE_CORE_WASM ?? resolve(import.meta.dir, "../../../workflow-core/target/wasm32-unknown-unknown/debug/workflow_evaluator.wasm");
export const MAX_SNAPSHOT_BYTES = 64 * 1_048_576;

export type CoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly kind: "domain"; readonly detail: CoreDomainError }
      | { readonly kind: "compile"; readonly detail: readonly CoreCompileError[] }
      | { readonly kind: "transport"; readonly detail: CoreTransportError } };
export type CoreStartupResult = { readonly ok: true; readonly value: CoreClient }
  | { readonly ok: false; readonly error: { readonly kind: "transport"; readonly detail: CoreTransportError } };
export interface CoreClientOptions { readonly wasm_path?: string }
export interface CoreChildHealth { readonly pid: null; readonly uptime_ms: number; readonly restart_count: number; readonly last_stderr_lines: readonly string[] }
type RequestInput<O extends CoreRequest["operation"]> = Extract<CoreRequest, { readonly operation: O }>["input"];
interface CoreWasmExports {
  readonly memory: WebAssembly.Memory;
  core_alloc(length: number): number;
  core_dealloc(pointer: number, length: number): void;
  core_process(pointer: number, length: number): number;
  core_response_len(): number;
}

function instantiate(module: WebAssembly.Module): CoreWasmExports {
  return new WebAssembly.Instance(module, {}).exports as unknown as CoreWasmExports;
}

function transport(kind: CoreTransportError["kind"], detail: string): CoreResult<never> {
  return { ok: false, error: { kind: "transport", detail: { kind, detail } } };
}

/** One synchronous WebAssembly instance keeps the compiled-workflow cache in process. */
export class CoreClient {
  private readonly module: WebAssembly.Module;
  private core: CoreWasmExports;
  private readonly startedAt = Date.now();
  private nextId = 0;
  private restartCount = 0;
  private closed = false;

  private constructor(wasm_path: string) {
    this.module = new WebAssembly.Module(new Uint8Array(readFileSync(wasm_path)));
    this.core = instantiate(this.module);
  }

  static start(options: CoreClientOptions = {}): CoreStartupResult {
    try { return { ok: true, value: new CoreClient(options.wasm_path ?? CORE_WASM_PATH) }; }
    catch (cause) { return { ok: false, error: { kind: "transport", detail: { kind: "malformed_request", detail: `failed to load core WASM: ${String(cause)}` } } }; }
  }

  get health(): CoreChildHealth {
    return { pid: null, uptime_ms: Date.now() - this.startedAt, restart_count: this.restartCount, last_stderr_lines: [] };
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
    let responseBytes: Uint8Array;
    try {
      const pointer = this.core.core_alloc(encoded.length);
      new Uint8Array(this.core.memory.buffer, pointer, encoded.length).set(encoded);
      const responsePointer = this.core.core_process(pointer, encoded.length);
      responseBytes = new Uint8Array(this.core.memory.buffer, responsePointer, this.core.core_response_len()).slice();
      this.core.core_dealloc(pointer, encoded.length);
    } catch (cause) {
      // A trap leaves the instance unusable: its state stays mutably borrowed and
      // its allocator may be mid-update, so every later call would trap too.
      // Replace it. Its program cache goes with it; commit recompiles a pinned
      // program the core has not cached.
      this.core = instantiate(this.module);
      this.restartCount += 1;
      return transport("malformed_request", `core invocation failed: ${String(cause)}`);
    }
    try {
      const response = decodeCoreResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)));
      if (!response || response.version !== CORE_PROTOCOL_VERSION) return transport("malformed_request", "core returned an invalid response");
      switch (response.result.status) {
        case "ok": return { ok: true, value: response.result.value };
        case "domain_error": return { ok: false, error: { kind: "domain", detail: response.result.value } };
        case "compile_errors": return { ok: false, error: { kind: "compile", detail: response.result.value } };
        case "transport_error": return { ok: false, error: { kind: "transport", detail: response.result.value } };
      }
    } catch (cause) { return transport("malformed_request", `core response is not valid JSON: ${String(cause)}`); }
  }

  close(): void { this.closed = true; }
}

/** Source and prompt texts (by path) that a workflow compiles from. */
export interface CompileInput { readonly workflow: Workflow; readonly prompts: { readonly [path: string]: string } }
/** Compile a workflow against the declared code operations and leave it in the core's program cache. */
export async function compileWorkflow(core: CoreClient, input: CompileInput): Promise<Traced<CompiledWorkflow>> {
  const response = await core.request("compile", { workflow: input.workflow, prompts: input.prompts, operations: [...OPERATION_REGISTRY] });
  if (!response.ok) {
    const detail = response.error.kind === "compile"
      ? response.error.detail.map((error) => `${error.path}:${error.span.start}..${error.span.end} [${error.check}] ${error.detail}`).join("; ")
      : response.error.detail.detail;
    return traced("compile", input.workflow.workflow, detail);
  }
  if (response.value.kind !== "compiled") return traced("compile", input.workflow.workflow, "core returned a non-compiled response");
  return { ok: true, value: response.value.value };
}

/** Each active stage's wanted workers, including an empty set when none are wanted. */
export interface WantedForUnit { readonly unit_id: string; readonly actions: readonly WantedWorker[] }
export function selectWanted(step: StepResult): readonly WantedForUnit[] {
  return step.snapshot.units.filter((unit) => unit.kind.kind === "stage" && unit.status.kind === "active")
    .map((unit) => ({ unit_id: unit.id, actions: step.wanted.filter((wanted) => wanted.unit === unit.id) }));
}
