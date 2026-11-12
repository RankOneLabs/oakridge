import { expect, spyOn, test } from "bun:test";
import { CoreClient, compileWorkflow, MAX_SNAPSHOT_BYTES } from "../src/core-client/client";
import type { StepSnapshot, Workflow } from "../src/core-client/core-types";

const workflow = {
  workflow: "simple", input: {},
  run: { units: { document: { stage: "document", input: {} } }, outcome: { draft: "document.outcome.draft" } },
  stages: { document: { input: {}, artifacts: { draft: { kind: "document", schema: "text" } },
    workers: { writer: { kind: "agent", prompts: { initial: "write.md" }, inputs: {}, produces: ["draft"] } },
    done_when: "approved(draft)", outcome: { draft: "latest(draft)" } } },
} as Workflow;

test("compile runs in process without spawning a child", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    const started = CoreClient.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const compiled = await started.value.request("compile", { workflow, prompts: { "write.md": "write" } });
    expect(compiled).toMatchObject({ ok: true, value: { kind: "compiled", value: { stages: ["document"], workflow: {
      input: { kind: "record", fields: {} }, stages: { document: { artifacts: { draft: { schema: { kind: "text" } } } } },
    } } } });
    expect(spawn).not.toHaveBeenCalled();
    started.value.close();
  } finally { spawn.mockRestore(); }
});

test("step evaluates a workflow compiled by the same WASM instance", async () => {
  const started = CoreClient.start();
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  try {
    const compiled = await started.value.request("compile", { workflow, prompts: { "write.md": "write" } });
    expect(compiled).toMatchObject({ ok: true, value: { kind: "compiled" } });
    if (!compiled.ok || compiled.value.kind !== "compiled") return;
    const snapshot: StepSnapshot = {
      run: { id: "run", root: "run" },
      units: [], attempts: [], revisions: [], decisions: [], retry_events: [],
    };
    const stepped = await started.value.request("step", {
      workflow_digest: compiled.value.value.digest,
      snapshot,
      incoming: { event: { kind: "launched", input: {} }, writer: { kind: "engine" }, ingress_id: "launch-1" },
    });
    expect(stepped.ok && stepped.value.kind).toBe("stepped");
    if (stepped.ok && stepped.value.kind === "stepped") {
      expect(stepped.value.value.snapshot.units.find((unit) => unit.id === "run"))
        .toMatchObject({ status: { kind: "active" }, input: {} });
    }
  } finally { started.value.close(); }
});

test("an oversized in-process snapshot has a clear error", async () => {
  const started = CoreClient.start();
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const snapshot = { body: "x".repeat(MAX_SNAPSHOT_BYTES + 1) } as unknown as StepSnapshot;
  const result = await started.value.request("step", { workflow_digest: "unused", snapshot,
    incoming: { kind: "start", value: {} } as never });
  expect(result).toMatchObject({ ok: false, error: { kind: "transport",
    detail: { kind: "oversized_payload", detail: expect.stringContaining("snapshot is") } } });
  started.value.close();
});

test("a core that trapped is replaced, so later requests still run", async () => {
  const started = CoreClient.start();
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const client = started.value;
  const compile = () => client.request("compile", { workflow, prompts: { "write.md": "write" } });
  // Trap inside the core's state borrow, as a panic or stack overflow would:
  // an input that runs past linear memory.
  const { core } = client as unknown as { core: { memory: WebAssembly.Memory; core_process(pointer: number, length: number): number } };
  expect(() => core.core_process(core.memory.buffer.byteLength, 64)).toThrow();
  expect(await compile()).toMatchObject({ ok: false, error: { kind: "transport",
    detail: { kind: "malformed_request", detail: expect.stringContaining("core invocation failed") } } });
  expect(client.health.restart_count).toBe(1);
  expect(await compile()).toMatchObject({ ok: true, value: { kind: "compiled" } });
  client.close();
});

test("cached compilation still checks changed prompt inputs", async () => {
  const { compileWorkflow } = await import("../src/core-client/client");
  const started = CoreClient.start();
  if (!started.ok) throw new Error(started.error.detail.detail);
  try {
    const first = await compileWorkflow(started.value, { workflow, prompts: { "write.md": "write" } });
    if (!first.ok) throw new Error(first.error.detail);
    const changed = await compileWorkflow(started.value, { workflow, prompts: { "write.md": "write {{undeclared}}" } });
    expect(changed.ok).toBe(false);
  } finally { started.value.close(); }
});

test("cached programs recompile after the WASM instance is replaced", async () => {
  const { compileWorkflow } = await import("../src/core-client/client");
  const started = CoreClient.start();
  if (!started.ok) throw new Error(started.error.detail.detail);
  const client = started.value;
  try {
    const input = { workflow, prompts: { "write.md": "write" } };
    const first = await compileWorkflow(client, input);
    if (!first.ok) throw new Error(first.error.detail);
    const { core } = client as unknown as { core: { memory: WebAssembly.Memory; core_process(pointer: number, length: number): number } };
    expect(() => core.core_process(core.memory.buffer.byteLength, 64)).toThrow();
    await client.request("compile", input);
    const compiled = await compileWorkflow(client, input);
    if (!compiled.ok) throw new Error(compiled.error.detail);
    const result = await client.request("step", { workflow_digest: compiled.value.digest,
      snapshot: { run: { id: "cache-run", root: "cache-run" }, units: [], attempts: [], revisions: [], decisions: [], retry_events: [] },
      incoming: { event: { kind: "launched", input: {} }, writer: { kind: "engine" } } });
    expect(result.ok && result.value.kind).toBe("stepped");
  } finally { client.close(); }
});


test("artifact schema version is unchanged when only authored presentation kind changes", async () => {
  const { readLaunchableCatalog, resolveLaunchableDefinition } = await import("../src/runtime/definition-store");
  const { artifactSchemaVersion } = await import("../src/adapters/observation-schema-version");
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  const resolved = resolveLaunchableDefinition(catalog.value.development);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  const started = CoreClient.start();
  if (!started.ok) throw new Error(started.error.detail.detail);
  try {
    const original = resolved.value;
    const stage = original.source.stages.analysis;
    const artifact = stage?.artifacts.analysis;
    if (!stage || !artifact) throw new Error("missing analysis fixture");
    const source = { ...original.source, stages: { ...original.source.stages, analysis: {
      ...stage,
      artifacts: { ...stage.artifacts,
        analysis: { ...artifact, kind: "record" as const } },
    } } };
    const first = await compileWorkflow(started.value, { workflow: original.source, prompts: original.prompts, operations: original.operations });
    const second = await compileWorkflow(started.value, { workflow: source, prompts: original.prompts, operations: original.operations });
    if (!first.ok || !second.ok) throw new Error(JSON.stringify([first, second]));
    const before = artifactSchemaVersion({ ...original, checked_program: first.value }, "analysis", "analysis");
    expect(before).not.toBeNull();
    expect(artifactSchemaVersion({ ...original, source, checked_program: second.value }, "analysis", "analysis")).toBe(before);
  } finally { started.value.close(); }
});
