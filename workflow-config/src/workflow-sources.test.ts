import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverWorkflowSources } from "./workflow-sources";

test("discovery uses the file location for audience and excludes shared files", () => {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-workflow-sources-"));
  try {
    for (const directory of ["samples", "shared"]) mkdirSync(resolve(root, "workflow-config", directory), { recursive: true });
    for (const file of ["probe.yaml", "samples/example.yaml", "shared/common.yaml"]) {
      writeFileSync(resolve(root, "workflow-config", file), "{}");
    }
    expect(discoverWorkflowSources(root)).toEqual([
      { name: "example", path: "workflow-config/samples/example.yaml", audience: "test_fixture" },
      { name: "probe", path: "workflow-config/probe.yaml", audience: "user" },
    ]);
    writeFileSync(resolve(root, "workflow-config/samples/probe.yaml"), "{}");
    expect(() => discoverWorkflowSources(root)).toThrow("Duplicate workflow name: probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository has five discovered workflows", () => {
  expect(discoverWorkflowSources(resolve(import.meta.dir, "../..")).map(({ name }) => name))
    .toEqual(["development", "fan-out", "portability", "review-loop", "study"]);
});
