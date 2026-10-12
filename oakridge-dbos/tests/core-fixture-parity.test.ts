import { expect, spyOn, test } from "bun:test";
import { CoreClient, MAX_SNAPSHOT_BYTES } from "../src/core-client/client";
import type { ScopedSnapshot, Workflow } from "../src/core-client/core-types";

const workflow = {
  workflow: "simple", input: {},
  run: { units: { document: { stage: "document", input: {} } }, outcome: { draft: "document.outcome.draft" } },
  stages: { document: { input: {}, artifacts: { draft: { schema: "text" } },
    workers: { writer: { kind: "agent", prompts: { initial: "write.md" }, inputs: {}, creates: ["draft"] } },
    done_when: "approved(draft)", outcome: { draft: "latest(draft)" } } },
} as Workflow;

test("compile runs in process without spawning a child", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    const started = CoreClient.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const compiled = await started.value.request("compile", { workflow, prompts: { "write.md": "write" } });
    expect(compiled).toMatchObject({ ok: true, value: { kind: "compiled", value: { stages: ["document"] } } });
    expect(spawn).not.toHaveBeenCalled();
    started.value.close();
  } finally { spawn.mockRestore(); }
});

test("an oversized in-process snapshot has a clear error", async () => {
  const started = CoreClient.start();
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const snapshot = { body: "x".repeat(MAX_SNAPSHOT_BYTES + 1) } as unknown as ScopedSnapshot;
  const result = await started.value.request("step", { workflow_digest: "unused", snapshot,
    incoming: { kind: "start", value: {} } as never });
  expect(result).toMatchObject({ ok: false, error: { kind: "transport",
    detail: { kind: "oversized_payload", detail: expect.stringContaining("snapshot is") } } });
  started.value.close();
});
