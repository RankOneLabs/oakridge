import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { computeEngineVersion, ENGINE_SOURCE_MANIFEST, selectApplicationVersion } from "../src/workflows/engine-version";
import { buildGraph } from "./dependency-graph";

test("engine manifest covers workflow imports and injected service implementations", () => {
  const root = resolve(import.meta.dir, "../src");
  const entries = ["workflows/topology.ts", "workflows/engine-version.ts", "core-client/client.ts",
    "storage/mutation-service.ts", "storage/sql-executor.ts", "effects/operations/production-provider.ts"];
  const sources = [...buildGraph(entries.map((path) => resolve(root, path))).keys()].map((path) => relative(root, path)).sort();
  expect([...ENGINE_SOURCE_MANIFEST].sort()).toEqual(sources);
});

test("changes in every engine dependency change the recovery version", () => {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-engine-version-"));
  try {
    for (const name of ENGINE_SOURCE_MANIFEST) {
      const path = resolve(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "original");
    }
    const workflows = resolve(root, "workflows");
    const original = computeEngineVersion(workflows);
    for (const name of ENGINE_SOURCE_MANIFEST) {
      writeFileSync(resolve(root, name), "changed");
      expect(computeEngineVersion(workflows)).not.toBe(original);
      writeFileSync(resolve(root, name), "original");
    }
    for (const name of ["http/app.ts", "projections/run-view.ts", "workflows/topology.test.ts"]) {
      mkdirSync(dirname(resolve(root, name)), { recursive: true });
      writeFileSync(resolve(root, name), "unrelated change");
    }
    expect(computeEngineVersion(workflows)).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator version override is retained", () => {
  expect(selectApplicationVersion({ DBOS_APPLICATION_VERSION: " rollback " })).toBe("rollback");
});
