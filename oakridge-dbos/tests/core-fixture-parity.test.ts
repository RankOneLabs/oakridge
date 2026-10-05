import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle, Snapshot, CheckedValue } from "../src/core-client/generated-contracts";
const root = resolve(import.meta.dir, "../..");
const binary = resolve(root, "workflow-core/target/debug/workflow-cli");
const bundle: DefinitionBundle = await Bun.file(resolve(root, "workflow-core/fixtures/bundles/minimal.json")).json();
const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
function snapshot(source = bundle, trigger = "begin"): Snapshot {
  return { owner: "instance", scope: source.root, version: 1, input: unit, state: { schema: "position", data: { kind: "variant", variant: "ready", value: unit } },
    trigger: { id: "trigger", key: trigger, payload: unit }, observations: [], timestamp_ms: 42, random_seed: 7 };
}
function startClient(path = binary, deadlineMs = 2_000, maxPendingRequests = 64): CoreClient {
  const started = CoreClient.start({ binary: path, deadlineMs, maxPendingRequests });
  if (!started.ok) throw new Error(started.error.detail.detail);
  return started.value;
}
test("shared fixture round trips through all five real binary operations", async () => {
  const client = startClient();
  try {
    const common = { bundle, available_operations: bundle.operations };
    const operations = [
      ["compile", common, "compiled"],
      ["validate_payload", { ...common, schema: "unit", payload: {} }, "validated"],
      ["evaluate", { ...common, snapshot: snapshot() }, "evaluated"],
      ["materialize", { bundle: await Bun.file(resolve(root, "workflow-core/fixtures/bundles/children-1.json")).json() as DefinitionBundle,
        available_operations: bundle.operations, snapshot: snapshot({ ...bundle, root: "batch" }), template: "item_0" }, "materialized"],
      ["explain", { ...common, snapshot: snapshot() }, "explained"],
    ] as const;
    for (const [operation, input, kind] of operations) {
      const result = await client.request(operation, input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.kind).toBe(kind);
    }
  } finally { client.close(); }
});
test("one, five, six and seven children execute through the same real binary", async () => {
  const client = startClient();
  try { for (const count of [1, 5, 6, 7]) {
    const source: DefinitionBundle = await Bun.file(resolve(root, `workflow-core/fixtures/bundles/children-${count}.json`)).json();
    const result = await client.request("evaluate", { bundle: source, available_operations: source.operations, snapshot: snapshot(source) });
    if (!result.ok || result.value.kind !== "evaluated" || result.value.value.kind !== "apply") throw new Error(JSON.stringify(result));
    expect(result.value.value.mutations.filter((mutation) => mutation.kind === "activate_child")).toHaveLength(count);
  } } finally { client.close(); }
});
test("domain rejection remains distinct from transport failure", async () => {
  const client = startClient();
  try { expect(await client.request("validate_payload", { bundle, available_operations: bundle.operations, schema: "unit", payload: "wrong" }))
    .toMatchObject({ ok: false, error: { kind: "domain", detail: { kind: "invalid_payload" } } }); }
  finally { client.close(); }
});
test("concurrent callers retain explicit request correlation", async () => {
  const client = startClient();
  try { const results = await Promise.all(Array.from({ length: 8 }, (_, index) => client.request("validate_payload", {
    bundle, available_operations: bundle.operations, schema: "text", payload: String(index) })));
    expect(results.map((result) => result.ok && result.value.kind === "validated" && result.value.value.data.kind === "string" ? result.value.value.data.value : null))
      .toEqual(Array.from({ length: 8 }, (_, index) => String(index)));
  } finally { client.close(); }
});
test("killed child reports typed termination", async () => {
  const client = startClient(); client.close();
  expect(await client.request("compile", { bundle, available_operations: bundle.operations })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
});
test("failed child start returns a transport result", () => {
  expect(CoreClient.start({ binary: resolve(tmpdir(), "missing-workflow-core-binary"), deadlineMs: 100 })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
});
interface RawResponse { readonly request_id: string; readonly truncated: boolean; readonly result: { readonly status: string; readonly value: { readonly kind: string } } }
function rawFrame(frame: string): RawResponse {
  const run = Bun.spawnSync({ cmd: [binary], stdin: Buffer.from(frame + "\n"), stdout: "pipe", stderr: "pipe" });
  return JSON.parse(new TextDecoder().decode(run.stdout).trim()) as RawResponse;
}
test("malformed frame has its own transport kind", () => expect(rawFrame("{").result.value.kind).toBe("malformed_frame"));
test("unsupported version has its own transport kind", () => expect(rawFrame(JSON.stringify({ version: 2, request_id: "r", operation: "compile" })).result.value.kind).toBe("unsupported_version"));
test("oversized payload has its own transport kind", () => expect(rawFrame("x".repeat(1_048_577)).result.value.kind).toBe("oversized_payload"));
test("unknown operation has its own transport kind", () => expect(rawFrame(JSON.stringify({ version: 1, request_id: "r", operation: "missing", input: {} })).result.value.kind).toBe("unknown_operation"));
test("duplicate JSON keys are rejected before overwrite", () => {
  const frame = JSON.stringify({ version: 1, request_id: "duplicate", operation: "compile", input: { bundle, available_operations: bundle.operations } }).replace('"language_version":1', '"language_version":1,"language_version":2');
  expect(rawFrame(frame).result.value.kind).toBe("duplicate_symbol");
});
test("responses echo the request ID and signal truncation", () => {
  const source = { ...bundle, prompts: bundle.prompts.map((prompt) => ({ ...prompt, content: "x".repeat(300_000) })) };
  const response = rawFrame(JSON.stringify({ version: 1, request_id: "large", operation: "compile", input: { bundle: source, available_operations: source.operations } }));
  expect(response).toMatchObject({ request_id: "large", truncated: true, result: { value: { kind: "oversized_payload" } } });
});
async function withChild(scriptBody: string, run: (client: CoreClient) => Promise<void>, deadlineMs = 1000, queue = 64): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), "core-protocol-")); const script = resolve(directory, "child.sh");
  writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`); chmodSync(script, 0o700);
  const client = startClient(script, deadlineMs, queue);
  try { await run(client); } finally { client.close(); rmSync(directory, { recursive: true, force: true }); }
}
test("mismatched request ID is rejected", () => withChild("IFS= read -r line\nprintf '%s\\n' '{\"version\":1,\"request_id\":\"wrong\",\"truncated\":false,\"result\":{\"status\":\"ok\",\"value\":{\"kind\":\"validated\",\"value\":{\"schema\":\"flag\",\"data\":{\"kind\":\"boolean\",\"value\":true}}}}}'", async (client) => {
  expect(await client.request("compile", { bundle, available_operations: bundle.operations })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "mismatched_request_id" } } });
}));
test("malformed success payload fails the generated decoder", () => withChild("IFS= read -r line\nprintf '%s\\n' '{\"version\":1,\"request_id\":\"1\",\"truncated\":false,\"result\":{\"status\":\"ok\",\"value\":{}}}'", async (client) => {
  expect(await client.request("compile", { bundle, available_operations: bundle.operations })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
}));
function stringResponseAtSize(bytes: number): string {
  const response = (value: string) => JSON.stringify({ version: 1, request_id: "1", truncated: false,
    result: { status: "ok", value: { kind: "validated", value: { schema: "text", data: { kind: "string", value } } } } });
  return response("x".repeat(bytes - new TextEncoder().encode(response("")).length));
}
test("response at the 256 KiB boundary is accepted", () => withChild(
  `IFS= read -r line\nprintf '%s\\n' '${stringResponseAtSize(262_144)}'`, async (client) => {
    expect((await client.request("compile", { bundle, available_operations: bundle.operations })).ok).toBe(true);
  }));
test("response above 256 KiB quarantines the child and fails all pending callers", () => withChild(
  `IFS= read -r line\nprintf '%s\\n' '${stringResponseAtSize(262_145)}'`, async (client) => {
    const responses = await Promise.all([client.request("compile", { bundle, available_operations: bundle.operations }),
      client.request("compile", { bundle, available_operations: bundle.operations })]);
    for (const response of responses) expect(response).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "oversized_payload" } } });
    expect(await client.request("compile", { bundle, available_operations: bundle.operations }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
  }));
test("safe integer endpoints round trip exactly through the real binary", async () => {
  const client = startClient();
  const source: DefinitionBundle = { ...bundle, schemas: [...bundle.schemas,
    { key: "number", shape: { kind: "integer", min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } }] };
  try {
    for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      expect(await client.request("validate_payload", { bundle: source, available_operations: source.operations, schema: "number", payload: value }))
        .toMatchObject({ ok: true, value: { kind: "validated", value: { data: { kind: "integer", value } } } });
    }
  } finally { client.close(); }
});
test("unsafe request metadata is rejected before sending and leaves the child usable", async () => {
  const client = startClient();
  try {
    expect(await client.request("evaluate", { bundle, available_operations: bundle.operations,
      snapshot: { ...snapshot(), version: Number.MAX_SAFE_INTEGER + 1 } }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
    expect((await client.request("compile", { bundle, available_operations: bundle.operations })).ok).toBe(true);
  } finally { client.close(); }
});
test("raw unsafe snapshot metadata cannot enter the Rust evaluator", () => {
  expect(rawFrame(JSON.stringify({ version: 1, request_id: "wide", operation: "evaluate", input: {
    bundle, available_operations: bundle.operations, snapshot: { ...snapshot(), random_seed: Number.MAX_SAFE_INTEGER + 1 } } })))
    .toMatchObject({ request_id: "wide", result: { status: "transport_error", value: { kind: "malformed_frame" } } });
});
test("unsafe integer success payload quarantines the child", () => withChild(
  `IFS= read -r line\nprintf '%s\\n' '${JSON.stringify({ version: 1, request_id: "1", truncated: false,
    result: { status: "ok", value: { kind: "validated", value: { schema: "number", data: { kind: "integer", value: Number.MAX_SAFE_INTEGER + 1 } } } } })}'`, async (client) => {
    expect(await client.request("compile", { bundle, available_operations: bundle.operations }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
  }));
test("unresponsive child hits deadline and is quarantined", () => withChild("IFS= read -r line\nsleep 1", async (client) => {
  expect(await client.request("compile", { bundle, available_operations: bundle.operations })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "unresponsive_child" } } });
  expect(await client.request("compile", { bundle, available_operations: bundle.operations })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
}, 20));
test("bounded queue refuses excess callers without discarding pending request", () => withChild("IFS= read -r line\nsleep 1", async (client) => {
  const first = client.request("compile", { bundle, available_operations: bundle.operations });
  expect(await client.request("compile", { bundle, available_operations: bundle.operations })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "queue_full" } } });
  await first;
}, 20, 1));

test("shared invalid compiler corpus retains typed diagnostics through the real binary", async () => {
  const directory = resolve(import.meta.dir, "../../workflow-core/fixtures/invalid");
  const cases: readonly { readonly file: string; readonly expected: string }[] = await Bun.file(resolve(directory, "manifest.json")).json();
  const client = startClient();
  try {
    for (const entry of cases) {
      const source: DefinitionBundle = await Bun.file(resolve(directory, entry.file)).json();
      expect(await client.request("compile", { bundle: source, available_operations: source.operations }))
        .toMatchObject({ ok: false, error: { kind: "domain", detail: { kind: entry.expected } } });
    }
  } finally { client.close(); }
});

test("unknown source fields are domain diagnostics with request correlation", () => {
  const response = rawFrame(JSON.stringify({ version: 1, request_id: "unknown-source", operation: "compile", input: {
    bundle: { ...bundle, invented: true }, available_operations: bundle.operations,
  } }));
  expect(response).toMatchObject({ request_id: "unknown-source", result: { status: "domain_error", value: { kind: "unknown_construct" } } });
});
