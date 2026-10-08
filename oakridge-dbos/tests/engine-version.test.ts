import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import * as engineVersion from "../src/workflows/engine-version";
import { buildGraph } from "./dependency-graph";

const { computeEngineSourceDigest, computeEngineVersion, computeStorageBaselineDigest,
  ENGINE_SOURCE_MANIFEST, selectApplicationVersion } = engineVersion;

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
    const baseline = resolve(root, "storage/migrations/0001_core_authority.sql");
    mkdirSync(dirname(baseline), { recursive: true });
    writeFileSync(baseline, "original storage");
    const workflows = resolve(root, "workflows");
    const core_binary = resolve(root, "workflow-cli");
    writeFileSync(core_binary, "original core");
    const version = (): string => computeEngineVersion({ workflows_dir: workflows, core_binary });
    const original = version();
    writeFileSync(baseline, "changed storage");
    expect(version()).not.toBe(original);
    writeFileSync(baseline, "original storage");
    const source_digest = computeEngineSourceDigest(workflows);
    const storage_digest = computeStorageBaselineDigest(workflows);
    writeFileSync(baseline, "changed storage");
    expect(computeStorageBaselineDigest(workflows)).not.toBe(storage_digest);
    expect(computeEngineSourceDigest(workflows)).toBe(source_digest);
    writeFileSync(baseline, "original storage");
    writeFileSync(core_binary, "rebuilt core");
    expect(version()).not.toBe(original);
    writeFileSync(core_binary, "original core");
    for (const name of ENGINE_SOURCE_MANIFEST) {
      writeFileSync(resolve(root, name), "changed");
      expect(version()).not.toBe(original);
      writeFileSync(resolve(root, name), "original");
    }
    for (const name of ["http/app.ts", "projections/run-view.ts", "workflows/topology.test.ts"]) {
      mkdirSync(dirname(resolve(root, name)), { recursive: true });
      writeFileSync(resolve(root, name), "unrelated change");
    }
    expect(version()).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator version override is retained", () => {
  expect(selectApplicationVersion("/nonexistent/workflow-cli", { DBOS_APPLICATION_VERSION: " rollback " })).toBe("rollback");
});
