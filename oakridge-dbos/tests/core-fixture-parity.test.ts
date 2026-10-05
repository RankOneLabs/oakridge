import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CoreClient } from "../src/core-client/client";

const root = resolve(import.meta.dir, "../..");
const binary = resolve(root, "workflow-core/target/debug/workflow-cli");
const bundle = await Bun.file(resolve(root, "workflow-core/fixtures/bundles/minimal.json")).json();
const snapshot = { facts: [], values: { approved: true }, observations: [], timestamp_ms: 42, random_seed: 7 };

function startClient(path = binary, deadlineMs = 2_000): CoreClient {
  const started = CoreClient.start({ binary: path, deadlineMs });
  if (!started.ok) throw new Error(started.error.detail.detail);
  return started.value;
}

test("shared fixture round trips through all five real binary operations", async () => {
  const client = startClient();
  try {
    const operations = [
      ["compile", { bundle }, "compiled"],
      ["validate_payload", { bundle, collection: "evidence", payload: { text: "yes" } }, "validated"],
      ["evaluate", { bundle, snapshot }, "evaluated"],
      ["materialize", { bundle, collection: "evidence", observations: [{ collection: "evidence", item_id: "one", payload: { text: "yes" }, accepted: true }] }, "materialized"],
      ["explain", { bundle, snapshot }, "explained"],
    ] as const;
    for (const [operation, input, expectedKind] of operations) {
      const response = await client.request(operation, input);
      expect(response.ok).toBe(true);
      if (response.ok) expect((response.value as { kind: string }).kind).toBe(expectedKind);
    }
  } finally { client.close(); }
});

test("domain rejection remains distinct from transport failure", async () => {
  const client = startClient();
  try {
    const response = await client.request("validate_payload", { bundle, collection: "evidence", payload: "wrong" });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.kind).toBe("domain");
  } finally { client.close(); }
});

test("killed child reports typed termination", async () => {
  const client = startClient();
  client.close();
  await Bun.sleep(20);
  const response = await client.request("compile", { bundle });
  expect(response).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
});

test("failed child start returns a transport result", () => {
  expect(CoreClient.start({ binary: resolve(tmpdir(), "missing-workflow-core-binary"), deadlineMs: 100 }))
    .toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
});

function rawFrame(frame: string): { request_id: string; truncated: boolean; result: { status: string; value: { kind: string } } } {
  const run = Bun.spawnSync({ cmd: [binary], stdin: Buffer.from(frame + "\n"), stdout: "pipe", stderr: "pipe" });
  return JSON.parse(new TextDecoder().decode(run.stdout).trim());
}

test("malformed frame has its own transport kind", () => {
  expect(rawFrame("{").result.value.kind).toBe("malformed_frame");
});

test("unsupported version has its own transport kind", () => {
  expect(rawFrame(JSON.stringify({ version: 2, request_id: "r", operation: "compile", input: { bundle } })).result.value.kind).toBe("unsupported_version");
});

test("oversized payload has its own transport kind", () => {
  expect(rawFrame("x".repeat(1_048_577)).result.value.kind).toBe("oversized_payload");
});

test("unknown operation has its own transport kind", () => {
  expect(rawFrame(JSON.stringify({ version: 1, request_id: "r", operation: "missing", input: {} })).result.value.kind).toBe("unknown_operation");
});

test("responses echo the request ID and signal truncation", () => {
  const longBundle = structuredClone(bundle);
  longBundle.decision = { kind: "wait", reason: "x".repeat(200_000) };
  const response = rawFrame(JSON.stringify({ version: 1, request_id: "large", operation: "evaluate", input: { bundle: longBundle, snapshot } }));
  expect(response.request_id).toBe("large");
  expect(response.truncated).toBe(true);
  expect(response.result.value.kind).toBe("oversized_payload");
});

test("mismatched request ID is rejected", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "core-protocol-"));
  const script = resolve(directory, "wrong-id.sh");
  writeFileSync(script, "#!/bin/sh\nIFS= read -r line\nprintf '%s\\n' '{\"version\":1,\"request_id\":\"wrong\",\"truncated\":false,\"result\":{\"status\":\"ok\",\"value\":{}}}'\n");
  chmodSync(script, 0o700);
  const client = startClient(script);
  try {
    const result = await client.request("compile", { bundle });
    expect(result).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "mismatched_request_id" } } });
  } finally { client.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unresponsive child hits the deadline", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "core-protocol-"));
  const script = resolve(directory, "sleep.sh");
  writeFileSync(script, "#!/bin/sh\nIFS= read -r line\nsleep 2\n");
  chmodSync(script, 0o700);
  const client = startClient(script, 20);
  try {
    const result = await client.request("compile", { bundle });
    expect(result).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "unresponsive_child" } } });
  } finally { client.close(); rmSync(directory, { recursive: true, force: true }); }
});
