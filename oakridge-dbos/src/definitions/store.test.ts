import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson } from "canonical-json";
import { DefinitionStoreError, loadDefinition, readJsonObject, readLaunchCatalog, readProgramObject, readPromptObject,
  resolveExecutionDefinition, resolveHistoricalDefinition, resolveLaunchDefinition } from "./store";
import { compileWorkflow, type CoreClient } from "../core-client/client";
import type { Workflow } from "../core-client/core-types";

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-definitions-"));
  for (const kind of ["workflows", "prompts", "operations", "programs"]) mkdirSync(resolve(root, kind));
  const put = (kind: string, bytes: Uint8Array | string, id = sha(bytes)) => {
    writeFileSync(resolve(root, kind, `${id}.${kind === "prompts" ? "md" : "json"}`), bytes);
    return id;
  };
  const json = (value: unknown) => { const result = canonicalJson(value); if (!result.ok) throw new Error(result.error.detail); return result.value; };
  const operationId = put("operations", json([]));
  const promptId = put("prompts", "prompt\n");
  const definitionId = put("workflows", json({ source: { workflow: "test", operations: operationId }, operations: operationId, prompts: { "a.md": promptId } }));
  return { root, put, json, operationId, promptId, definitionId, close: () => rmSync(root, { recursive: true, force: true }) };
}
function kindOf(run: () => unknown): string {
  try { run(); return "accepted"; }
  catch (error) { if (!(error instanceof DefinitionStoreError)) throw error; return error.kind; }
}

test("a definition loads only after every referenced object verifies", () => {
  const f = fixture();
  try { expect(loadDefinition(f.root, f.definitionId).prompts["a.md"]).toBe("prompt\n"); }
  finally { f.close(); }
});
test("invalid UTF-8 is identified in every store kind", () => {
  const f = fixture();
  try {
    const bytes = Uint8Array.of(0xff);
    const id = sha(bytes);
    for (const kind of ["workflows", "operations", "prompts", "programs"] as const) {
      f.put(kind, bytes, id);
      const read = kind === "prompts" ? () => readPromptObject(f.root, id)
        : kind === "programs" ? () => readProgramObject(f.root, id)
          : () => readJsonObject(f.root, kind, id);
      expect(kindOf(read)).toBe("InvalidUtf8");
    }
  } finally { f.close(); }
});
test("prompt byte faults have distinct names", () => {
  const f = fixture();
  try {
    for (const [bytes, expected] of [["\uFEFFprompt\n", "PromptBOM"], ["a\rb\n", "PromptCR"], ["prompt", "PromptNewline"], ["prompt\n\n", "PromptNewline"]] as const) {
      const id = f.put("prompts", bytes);
      expect(kindOf(() => readPromptObject(f.root, id))).toBe(expected);
    }
  } finally { f.close(); }
});
test("JSON canonicality and filename hashes are independent checks", () => {
  const f = fixture();
  try {
    const newline = f.put("operations", "[]\n");
    expect(kindOf(() => readJsonObject(f.root, "operations", newline))).toBe("NonCanonicalJson");
    const reordered = f.put("operations", '{"b":2,"a":1}');
    expect(kindOf(() => readJsonObject(f.root, "operations", reordered))).toBe("NonCanonicalJson");
    f.put("operations", "[]", "0".repeat(64));
    expect(kindOf(() => readJsonObject(f.root, "operations", "0".repeat(64)))).toBe("StoreHashMismatch");
  } finally { f.close(); }
});
test("missing transitive references name their path or ID", () => {
  const f = fixture();
  try {
    const missing = "f".repeat(64);
    const prompt = f.put("workflows", f.json({ source: { operations: f.operationId }, operations: f.operationId, prompts: { "gone.md": missing } }));
    expect(kindOf(() => loadDefinition(f.root, prompt))).toBe("MissingPromptReference");
    const operation = f.put("workflows", f.json({ source: { operations: missing }, operations: missing, prompts: {} }));
    expect(kindOf(() => loadDefinition(f.root, operation))).toBe("MissingOperationReference");
  } finally { f.close(); }
});
test("committed generated definitions resolve", () => {
  const root = resolve(import.meta.dir, "../../../definitions");
  const catalog = readLaunchCatalog(root);
  for (const id of Object.values(catalog)) {
    expect(resolveExecutionDefinition(id, root).id).toBe(id);
    expect(resolveLaunchDefinition(id, root).id).toBe(id);
  }
});
test("historical definition reads load the exported program without compiling", () => {
  const f = fixture();
  try {
    const program = { digest: "recorded-core-digest", workflow: { workflow: "historical" }, stages: [], operations: [] };
    f.put("programs", f.json(program), f.definitionId);
    expect(resolveHistoricalDefinition(f.definitionId, f.root).program.digest).toBe("recorded-core-digest");
  } finally { f.close(); }
});
test("a missing or malformed exported program names the historical object", () => {
  const f = fixture();
  try {
    expect(kindOf(() => resolveHistoricalDefinition(f.definitionId, f.root))).toBe("MissingStoreObject");
    f.put("programs", f.json({ digest: "recorded" }), f.definitionId);
    expect(kindOf(() => resolveHistoricalDefinition(f.definitionId, f.root))).toBe("InvalidProgram");
  } finally { f.close(); }
});
test("an object absent from the launch catalog cannot start a run", () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, "launchable.json"), f.json({ other: "f".repeat(64) }));
    expect(kindOf(() => resolveLaunchDefinition(f.definitionId, f.root))).toBe("NotLaunchable");
    expect(resolveExecutionDefinition(f.definitionId, f.root).id).toBe(f.definitionId);
  } finally { f.close(); }
});
test("invalid catalog UTF-8 is a named store fault", () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, "launchable.json"), Uint8Array.of(0xff));
    expect(kindOf(() => readLaunchCatalog(f.root))).toBe("InvalidUtf8");
  } finally { f.close(); }
});
test("direct compile refuses a caller-chosen identity and missing operations", async () => {
  const workflow = { workflow: "test", input: {}, run: { units: {}, outcome: {} }, stages: {} } as Workflow;
  const core = null as unknown as CoreClient;
  const missing = await compileWorkflow(core, { workflow, prompts: {} } as unknown as Parameters<typeof compileWorkflow>[1]);
  expect(missing.ok ? "" : missing.error.detail).toContain("MissingOperations");
  const spoofed = await compileWorkflow(core, { workflow, prompts: {}, operations: [], definition_id: "f".repeat(64) } as unknown as Parameters<typeof compileWorkflow>[1]);
  expect(spoofed.ok ? "" : spoofed.error.detail).toContain("UnverifiedDefinitionId");
});
