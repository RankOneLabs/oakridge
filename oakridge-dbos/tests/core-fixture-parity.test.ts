import { CORE_MAX_FRAME_BYTES, CORE_MAX_RESPONSE_BYTES, CORE_PROTOCOL_VERSION } from "../src/core-client/generated-contracts";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CoreClient } from "../src/core-client/client";
import { PROVIDER_CATALOG } from "../src/effects/provider-catalog";
import type { DefinitionBundle, Snapshot, CheckedValue } from "../src/core-client/generated-contracts";
const root = resolve(import.meta.dir, "../..");
const binary = resolve(root, "workflow-core/target/debug/workflow-cli");
const bundle: DefinitionBundle = await Bun.file(resolve(root, "workflow-core/fixtures/bundles/minimal.json")).json();
const catalog = { operations: PROVIDER_CATALOG.operations.map((operation) => operation),
  providers: PROVIDER_CATALOG.providers };
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
    const common = { bundle };
    const operations = [
      ["compile", common, "compiled"],
      ["validate_payload", { ...common, schema: "unit", payload: {} }, "validated"],
      ["evaluate", { ...common, snapshot: snapshot() }, "evaluated"],
      ["materialize", { bundle: await Bun.file(resolve(root, "workflow-core/fixtures/bundles/children-1.json")).json() as DefinitionBundle,
        snapshot: snapshot({ ...bundle, root: "batch" }), template: "item_0" }, "materialized"],
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
    const result = await client.request("evaluate", { bundle: source, snapshot: snapshot(source) });
    if (!result.ok || result.value.kind !== "evaluated" || result.value.value.kind !== "apply") throw new Error(JSON.stringify(result));
    expect(result.value.value.mutations.filter((mutation) => mutation.kind === "activate_child")).toHaveLength(count);
  } } finally { client.close(); }
});
test("domain rejection remains distinct from transport failure", async () => {
  const client = startClient();
  try { expect(await client.request("validate_payload", { bundle, schema: "unit", payload: "wrong" }))
    .toMatchObject({ ok: false, error: { kind: "domain", detail: { kind: "invalid_payload" } } }); }
  finally { client.close(); }
});
test("concurrent callers retain explicit request correlation", async () => {
  const client = startClient();
  try { const results = await Promise.all(Array.from({ length: 8 }, (_, index) => client.request("validate_payload", {
    bundle, schema: "text", payload: String(index) })));
    expect(results.map((result) => result.ok && result.value.kind === "validated" && result.value.value.data.kind === "string" ? result.value.value.data.value : null))
      .toEqual(Array.from({ length: 8 }, (_, index) => String(index)));
  } finally { client.close(); }
});
test("killed child reports typed termination", async () => {
  const client = startClient(); client.close();
  expect(await client.request("compile", { bundle })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
});
test("failed child start returns a transport result", () => {
  expect(CoreClient.start({ binary: resolve(tmpdir(), "missing-workflow-core-binary"), deadlineMs: 100 })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
});
interface RawResponse { readonly request_id: string; readonly truncated: boolean; readonly result: { readonly status: string; readonly value: { readonly kind: string } } }
function rawFrame(frame: string): RawResponse {
  const run = Bun.spawnSync({ cmd: [binary], stdin: Buffer.from(frame + "\n"), stdout: "pipe", stderr: "pipe" });
  return JSON.parse(new TextDecoder().decode(run.stdout).trim()) as RawResponse;
}
function rawFrames(frames: readonly object[], args: readonly string[] = []): RawResponse[] {
  const run = Bun.spawnSync({ cmd: [binary, ...args], stdin: Buffer.from(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(run.stdout).trim().split("\n").map((line) => JSON.parse(line) as RawResponse);
}
test("digest request evaluates after compile and unknown digest is typed", () => {
  const compiled = rawFrames([{ version: CORE_PROTOCOL_VERSION, request_id: "compile", operation: "compile", input: { bundle, catalog } }])[0]!;
  const digest = (compiled.result.value as unknown as { value: { digest: string } }).value.digest;
  const responses = rawFrames([
    { version: CORE_PROTOCOL_VERSION, request_id: "compile", operation: "compile", input: { bundle, catalog } },
    { version: CORE_PROTOCOL_VERSION, request_id: "evaluate", operation: "evaluate", input: { bundle_digest: digest, snapshot: snapshot() } },
    { version: CORE_PROTOCOL_VERSION, request_id: "unknown", operation: "evaluate", input: { bundle_digest: "missing", snapshot: snapshot() } },
  ]);
  expect(responses.map((response) => [response.request_id, response.result.status, response.result.value.kind])).toEqual([
    ["compile", "ok", "compiled"], ["evaluate", "ok", "evaluated"], ["unknown", "domain_error", "unknown_bundle"],
  ]);
});
test("client recompiles a digest after LRU eviction", async () => {
  const client = startClient();
  try {
    for (let index = 0; index < 33; index++) {
      const source = { ...bundle, key: `cache-${index}` };
      const compiled = await client.request("compile", { bundle: source });
      expect(compiled.ok).toBe(true);
    }
    const source = { ...bundle, key: "cache-0" };
    expect(await client.request("evaluate", { bundle: source, snapshot: snapshot(source) })).toMatchObject({ ok: true, value: { kind: "evaluated" } });
  } finally { client.close(); }
});
test("concurrent callers share one source re-send", async () => {
  const client = startClient(binary, 2_000, 1);
  try {
    const [first, second] = await Promise.all([
      client.request("compile", { bundle }), client.request("compile", { bundle }),
    ]);
    expect(first).toMatchObject({ ok: true, value: { kind: "compiled" } });
    expect(second).toEqual(first);
  } finally { client.close(); }
});
test("CLI host ceilings reject a larger requested budget", () => {
  const response = rawFrames([{ version: CORE_PROTOCOL_VERSION, request_id: "host", operation: "compile", input: { bundle, catalog } }],
    ["--max-list-items", "10000", "--max-depth", "128", "--evaluation-budget", "100"])[0]!;
  expect(response).toMatchObject({ request_id: "host", result: { status: "domain_error", value: { kind: "limit_exceeds_host" } } });
});
// Frame-sized payloads take a few seconds to build and parse; the default 5 s is too tight on CI.
const OVERSIZED_TEST_TIMEOUT_MS = 60_000;
test("oversized frames echo the original request ID", () => {
  const response = rawFrame(JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "oversized-origin", operation: "compile", input: { bundle, catalog }, padding: "x".repeat(CORE_MAX_FRAME_BYTES) }));
  expect(response).toMatchObject({ request_id: "oversized-origin", result: { value: { kind: "oversized_payload" } } });
}, OVERSIZED_TEST_TIMEOUT_MS);
test("malformed frame has its own transport kind", () => expect(rawFrame("{").result.value.kind).toBe("malformed_frame"));
test("unsupported version has its own transport kind", () => expect(rawFrame(JSON.stringify({ version: CORE_PROTOCOL_VERSION + 1, request_id: "r", operation: "compile" })).result.value.kind).toBe("unsupported_version"));
test("oversized payload has its own transport kind", () => expect(rawFrame("x".repeat(CORE_MAX_FRAME_BYTES + 1)).result.value.kind).toBe("oversized_payload"), OVERSIZED_TEST_TIMEOUT_MS);
test("unknown operation has its own transport kind", () => expect(rawFrame(JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "r", operation: "missing", input: {} })).result.value.kind).toBe("unknown_operation"));
test("duplicate JSON keys are rejected before overwrite", () => {
  const frame = JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "duplicate", operation: "compile", input: { bundle, catalog } }).replace('"language_version":1', '"language_version":1,"language_version":2');
  expect(rawFrame(frame).result.value.kind).toBe("duplicate_symbol");
});
test("compile response echoes the request ID and omits the checked source", () => {
  const source = bundle;
  const response = rawFrame(JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "large", operation: "compile", input: { bundle: source, catalog } }));
  expect(response).toMatchObject({ request_id: "large", truncated: false, result: { status: "ok", value: { kind: "compiled", value: { digest: expect.any(String), scopes: expect.any(Array) } } } });
  expect(JSON.stringify(response)).not.toContain('"content_digest"');
});
async function withChild(scriptBody: string, run: (client: CoreClient, script: string) => Promise<void>, deadlineMs = 1000, queue = 64, files: Readonly<Record<string, string>> = {}): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), "core-protocol-")); const script = resolve(directory, "child.sh");
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(directory, name), content);
  writeFileSync(script, `#!/bin/sh\ncd "$(dirname "$0")"\n${scriptBody}\n`); chmodSync(script, 0o700);
  const client = startClient(script, deadlineMs, queue);
  try { await run(client, script); } finally { client.close(); rmSync(directory, { recursive: true, force: true }); }
}
test("an unrecognized request ID is dropped without disturbing the pending request", () => withChild(
  `IFS= read -r line\nprintf '%s\\n' '{\"version\":${CORE_PROTOCOL_VERSION},\"request_id\":\"wrong\",\"truncated\":false,\"result\":{\"status\":\"ok\",\"value\":{\"kind\":\"validated\",\"value\":{\"schema\":\"flag\",\"data\":{\"kind\":\"boolean\",\"value\":true}}}}}'\nprintf '%s\\n' '{\"version\":${CORE_PROTOCOL_VERSION},\"request_id\":\"1\",\"truncated\":false,\"result\":{\"status\":\"ok\",\"value\":{\"kind\":\"compiled\",\"value\":{\"digest\":\"deadbeef\",\"scopes\":[]}}}}'\nsleep 2`, async (client) => {
  expect(await client.request("compile", { bundle })).toMatchObject({ ok: true, value: { kind: "compiled" } });
  expect(client.health.restart_count).toBe(0);
}));
test("malformed success payload fails the generated decoder", () => withChild(`IFS= read -r line\nprintf '%s\\n' '{\"version\":${CORE_PROTOCOL_VERSION},\"request_id\":\"1\",\"truncated\":false,\"result\":{\"status\":\"ok\",\"value\":{}}}'`, async (client) => {
  expect(await client.request("compile", { bundle })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
}));
function stringResponseAtSize(bytes: number): string {
  const response = (value: string) => JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "1", truncated: false,
    result: { status: "ok", value: { kind: "validated", value: { schema: "text", data: { kind: "string", value } } } } });
  return response("x".repeat(bytes - new TextEncoder().encode(response("")).length));
}
// A boundary-sized response is streamed from a file: the shell would spend seconds parsing it as a literal.
test("response at the configured response boundary is accepted", () => withChild(
  "IFS= read -r line\ncat response.json", async (client) => {
    expect((await client.request("compile", { bundle })).ok).toBe(true);
  }, 10_000, 64, { "response.json": `${stringResponseAtSize(CORE_MAX_RESPONSE_BYTES)}\n` }), OVERSIZED_TEST_TIMEOUT_MS);
test("response above configured response respawns the child", () => withChild(
  "IFS= read -r line\ncat response.json", async (client) => {
    const responses = await Promise.all([client.request("compile", { bundle }),
      client.request("compile", { bundle })]);
    for (const response of responses) expect(response).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "oversized_payload" } } });
    expect(await client.request("compile", { bundle }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "oversized_payload" } } });
  }, 10_000, 64, { "response.json": `${stringResponseAtSize(CORE_MAX_RESPONSE_BYTES + 1)}\n` }), OVERSIZED_TEST_TIMEOUT_MS);
test("safe integer endpoints round trip exactly through the real binary", async () => {
  const client = startClient();
  const source: DefinitionBundle = { ...bundle, schemas: [...bundle.schemas,
    { key: "number", shape: { kind: "integer", min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } }] };
  try {
    for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      expect(await client.request("validate_payload", { bundle: source, schema: "number", payload: value }))
        .toMatchObject({ ok: true, value: { kind: "validated", value: { data: { kind: "integer", value } } } });
    }
  } finally { client.close(); }
});
test("unsafe request metadata is rejected before sending and leaves the child usable", async () => {
  const client = startClient();
  try {
    expect(await client.request("evaluate", { bundle,
      snapshot: { ...snapshot(), version: Number.MAX_SAFE_INTEGER + 1 } }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
    expect((await client.request("compile", { bundle })).ok).toBe(true);
  } finally { client.close(); }
});
test("unserializable bundle is a typed transport failure, not a rejected promise", async () => {
  const client = startClient();
  try {
    const cyclic: Record<string, unknown> = { ...bundle };
    cyclic.self = cyclic;
    for (const operation of ["compile", "evaluate"] as const) {
      expect(await client.request(operation, { bundle: cyclic as unknown as DefinitionBundle, snapshot: snapshot() }))
        .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
    }
    expect(await client.request("evaluate", { bundle: { ...bundle, limits: { ...bundle.limits, max_depth: 1n as unknown as number } }, snapshot: snapshot() }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
    expect((await client.request("compile", { bundle })).ok).toBe(true);
  } finally { client.close(); }
});
test("raw unsafe snapshot metadata cannot enter the Rust evaluator", () => {
  expect(rawFrame(JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "wide", operation: "evaluate", input: {
    bundle, snapshot: { ...snapshot(), random_seed: Number.MAX_SAFE_INTEGER + 1 } } })))
    .toMatchObject({ request_id: "wide", result: { status: "transport_error", value: { kind: "malformed_frame" } } });
});
test("unsafe integer success payload quarantines the child", () => withChild(
  `IFS= read -r line\nprintf '%s\\n' '${JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "1", truncated: false,
    result: { status: "ok", value: { kind: "validated", value: { schema: "number", data: { kind: "integer", value: Number.MAX_SAFE_INTEGER + 1 } } } } })}'`, async (client) => {
    expect(await client.request("compile", { bundle }))
      .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
  }));
test("unresponsive child hits deadline without killing the child", () => withChild("IFS= read -r line\nsleep 1", async (client) => {
  expect(await client.request("compile", { bundle })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "unresponsive_child" } } });
  expect(await client.request("compile", { bundle })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "unresponsive_child" } } });
  expect(client.health.restart_count).toBe(0);
}, 20));
test("in-flight bound refuses excess callers without discarding pending request", () => withChild("IFS= read -r line\nsleep 1", async (client) => {
  const first = client.request("compile", { bundle });
  expect(await client.request("compile", { bundle: { ...bundle, key: "second" } })).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "queue_full" } } });
  await first;
}, 20, 1));

test("shared invalid compiler corpus retains typed diagnostics through the real binary", async () => {
  const directory = resolve(import.meta.dir, "../../workflow-core/fixtures/invalid");
  const cases: readonly { readonly file: string; readonly expected: string }[] = await Bun.file(resolve(directory, "manifest.json")).json();
  const client = startClient();
  try {
    for (const entry of cases) {
      const source: DefinitionBundle = await Bun.file(resolve(directory, entry.file)).json();
      expect(await client.request("compile", { bundle: source }))
        .toMatchObject({ ok: false, error: { kind: "domain", detail: { kind: entry.expected } } });
    }
  } finally { client.close(); }
});

test("unknown source fields are domain diagnostics with request correlation", () => {
  const response = rawFrame(JSON.stringify({ version: CORE_PROTOCOL_VERSION, request_id: "unknown-source", operation: "compile", input: {
    bundle: { ...bundle, invented: true }, catalog,
  } }));
  expect(response).toMatchObject({ request_id: "unknown-source", result: { status: "domain_error", value: { kind: "malformed_bundle", path: "invented" } } });
});

interface ClientWriteAccess { writeFrame(id: string, frame: string, generation: number): Promise<void> }
interface ClientProcessAccess { process: ReturnType<typeof Bun.spawn> | null }
interface ClientPipeOverrides { readonly write?: Bun.FileSink["write"]; readonly flush?: Bun.FileSink["flush"] }
interface HeldPipeFlush { readonly started: Promise<void>; readonly release: () => void }
function overrideClientPipe(client: CoreClient, overrides: ClientPipeOverrides): void {
  const access = client as unknown as ClientProcessAccess;
  const child = access.process;
  const stdin = child?.stdin;
  if (!child || !stdin || typeof stdin === "number") throw new Error("child pipe missing");
  // Bun's native sink methods are read-only; wrap the IO boundary instead.
  const pipe = new Proxy(stdin, {
    get(target, key) {
      if (key === "write" && overrides.write) return overrides.write;
      if (key === "flush" && overrides.flush) return overrides.flush;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  access.process = new Proxy(child, {
    get(target, key) {
      if (key === "stdin") return pipe;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function holdPipeFlush(client: CoreClient): HeldPipeFlush {
  const child = (client as unknown as ClientProcessAccess).process;
  const stdin = child?.stdin;
  if (!stdin || typeof stdin === "number") throw new Error("child pipe missing");
  const write = stdin.write.bind(stdin);
  const flush = stdin.flush.bind(stdin);
  const frames: string[] = [];
  let release = () => {};
  let notify_started = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { notify_started = resolve; });
  overrideClientPipe(client, {
    write: (data) => {
      if (typeof data !== "string") throw new Error("expected a JSON frame");
      frames.push(data);
      return new TextEncoder().encode(data).length;
    },
    flush: async () => {
      notify_started();
      await held;
      for (const frame of frames.splice(0)) write(frame);
      return await flush();
    },
  });
  return { started, release };
}
test("a slow pipe flush does not spend the request deadline", async () => {
  const client = startClient(binary, 30);
  const held = holdPipeFlush(client);
  try {
    const pending = client.request("compile", { bundle });
    await held.started;
    await Bun.sleep(80);
    held.release();
    expect(await pending).toMatchObject({ ok: true, value: { kind: "compiled" } });
  } finally { held.release(); client.close(); }
});

test("a newer request's deadline failure settles only that request and leaves the older pending request to complete", () => withChild(
  `python3 -c "
import json, sys, time
first = True
for line in sys.stdin:
    req = json.loads(line)
    if first:
        first = False
        time.sleep(0.06)
    sys.stdout.write(json.dumps({'version': ${CORE_PROTOCOL_VERSION}, 'request_id': req['request_id'], 'truncated': False,
        'result': {'status': 'ok', 'value': {'kind': 'compiled', 'value': {'digest': 'deadbeef', 'scopes': []}}}}) + chr(10))
    sys.stdout.flush()
"`, async (client) => {
    const writable = client as unknown as ClientWriteAccess;
    const write = writable.writeFrame.bind(client);
    let should_delay = true;
    writable.writeFrame = async (id, frame, generation) => {
      if (should_delay) { should_delay = false; await Bun.sleep(150); }
      await write(id, frame, generation);
    };
    const older = client.request("compile", { bundle });
    const newer = client.request("compile", { bundle: { ...bundle, key: "newer" } });
    expect(await newer).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "unresponsive_child" } } });
    expect(await older).toMatchObject({ ok: true, value: { kind: "compiled" } });
    expect(client.health.restart_count).toBe(0);
  }, 30));

test("a failed pipe write for one request settles only that request and leaves the child usable", () => withChild(
  `exec "${binary}"`, async (client) => {
    const child = (client as unknown as ClientProcessAccess).process;
    const stdin = child?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("child pipe missing");
    const write = stdin.write.bind(stdin);
    let write_count = 0;
    overrideClientPipe(client, {
      write: (data) => {
        if (++write_count === 2) throw new Error("fixture pipe write failed");
        return write(data);
      },
    });
    const older = client.request("compile", { bundle });
    const newer = client.request("compile", { bundle: { ...bundle, key: "newer" } });
    expect(await newer).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child", detail: expect.stringContaining("fixture pipe write failed") } } });
    expect(await older).toMatchObject({ ok: true, value: { kind: "compiled" } });
    expect(client.health.restart_count).toBe(0);
  }));

test("a malformed response for one request settles only that request and leaves the older pending request to complete", () => withChild(
  `IFS= read -r first
IFS= read -r second
printf '%s\\n' '{"version":${CORE_PROTOCOL_VERSION},"request_id":"2","truncated":false,"result":{"status":"ok","value":{}}}'
printf '%s\\n' '{"version":${CORE_PROTOCOL_VERSION},"request_id":"1","truncated":false,"result":{"status":"ok","value":{"kind":"compiled","value":{"digest":"deadbeef","scopes":[]}}}}'
sleep 2`, async (client) => {
    const older = client.request("compile", { bundle });
    const newer = client.request("compile", { bundle: { ...bundle, key: "newer" } });
    expect(await newer).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "malformed_frame" } } });
    expect(await older).toMatchObject({ ok: true, value: { kind: "compiled" } });
    expect(client.health.restart_count).toBe(0);
  }));

test("failed replacement spawn settles survivors and a later request reopens the client", () => withChild(
  'rm -- "$0"\nIFS= read -r line\necho unavailable >&2\nexit 1', async (client, script) => {
    const first = client.request("compile", { bundle });
    const survivor = client.request("compile", { bundle: { ...bundle, key: "survivor" } });
    expect(await first).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    expect(await survivor).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    expect(client.health.last_stderr_lines).toContain("unavailable");
    writeFileSync(script, `#!/bin/sh\nIFS= read -r line\nprintf '%s\\n' '{"version":${CORE_PROTOCOL_VERSION},"request_id":"3","truncated":false,"result":{"status":"ok","value":{"kind":"compiled","value":{"digest":"ready","scopes":[]}}}}'\n`);
    chmodSync(script, 0o700);
    expect(await client.request("compile", { bundle: { ...bundle, key: "later" } }))
      .toMatchObject({ ok: true, value: { kind: "compiled" } });
  }), 10_000);

test("invalid UTF-8 stderr stays bounded after decoding in health and fault detail", () => withChild(
  `python3 -c 'import sys; sys.stderr.buffer.write(bytes([255]) * 20000 + "😀tail".encode()); sys.stderr.buffer.flush()'
sleep 0.05
IFS= read -r line
exit 1`, async (client) => {
    const failure = await client.request("compile", { bundle });
    if (failure.ok || failure.error.kind !== "transport") throw new Error("expected transport failure");
    const stderr = failure.error.detail.detail.split("; child stderr: ")[1];
    if (stderr === undefined) throw new Error("expected child stderr");
    const health_stderr = client.health.last_stderr_lines.join("\n");
    expect(new TextEncoder().encode(stderr).length).toBeLessThanOrEqual(16_384);
    expect(health_stderr).toBe(stderr);
    expect(stderr).toEndWith("😀tail");
    expect(stderr).toContain("�");
  }));

test("child deaths are rate-limited and stderr remains bounded in health and fault detail", () => withChild(
  "printf '%020000d\\n' 0 >&2\nsleep 0.05\nexit 1", async (client) => {
    const first = await client.request("compile", { bundle });
    expect(first).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    if (first.ok || first.error.kind !== "transport") throw new Error("expected transport failure");
    expect(first.error.detail.detail).toContain("child stderr:");
    const began = Date.now();
    const second = await client.request("compile", { bundle });
    expect(second).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);
    expect(client.health.restart_count).toBeGreaterThanOrEqual(1);
    expect(new TextEncoder().encode(client.health.last_stderr_lines.join("\\n")).length).toBeLessThanOrEqual(16_384);
  }, 1000));

test("both in-flight requests survive a killed child; respawn silently re-sends the source on unknown_bundle", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "core-respawn-"));
  const script = resolve(directory, "child.py");
  const log = resolve(directory, "operations.log");
  writeFileSync(script, `#!/usr/bin/env python3
import json, subprocess, sys
child = subprocess.Popen([${JSON.stringify(binary)}], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
for line in sys.stdin:
    operation = json.loads(line)['operation']
    with open(${JSON.stringify(log)}, 'a') as output: output.write(operation + '\\n')
    child.stdin.write(line)
    child.stdin.flush()
    sys.stdout.write(child.stdout.readline())
    sys.stdout.flush()
`);
  chmodSync(script, 0o700);
  const client = startClient(script);
  try {
    expect(await client.request("compile", { bundle })).toMatchObject({ ok: true, value: { kind: "compiled" } });
    const pid = client.health.pid;
    if (pid === null) throw new Error("child missing");
    process.kill(pid, "SIGSTOP");
    const pending = client.request("evaluate", { bundle, snapshot: snapshot() });
    const survivor = client.request("validate_payload", { bundle, schema: "unit", payload: {} });
    await Bun.sleep(20);
    process.kill(pid, "SIGKILL");
    expect(await pending).toMatchObject({ ok: true, value: { kind: "evaluated" } });
    expect(await survivor).toMatchObject({ ok: true, value: { kind: "validated" } });
    expect(await client.request("evaluate", { bundle, snapshot: snapshot() })).toMatchObject({ ok: true, value: { kind: "evaluated" } });
    const operations = (await Bun.file(log).text()).trim().split("\n");
    expect(operations.filter((operation) => operation === "compile").length).toBeGreaterThanOrEqual(2);
    expect(client.health.restart_count).toBe(1);
  } finally { client.close(); rmSync(directory, { recursive: true, force: true }); }
});
