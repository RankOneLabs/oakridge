import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { readStoredPrompts, resolveBundlePrompts, type PromptContent } from "../src/storage/prompt-content";
import type { SqlExecutor } from "../src/storage/sql-executor";

const PATH = "workflow-config/prompts/dev-flow/test_prompt.md";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const bundleWith = (content_digest: string): DefinitionBundle =>
  ({ key: "prompt-test", prompts: [{ key: "build", path: PATH, input_schema: "session_action", content_digest }] }) as unknown as DefinitionBundle;

/** The prompt_content table, keyed by digest, behind the one lookup statement the module issues. */
function promptStore(rows: readonly PromptContent[]): SqlExecutor {
  const table = new Map(rows.map((row) => [row.content_digest, row]));
  return {
    async query<Row extends object>(_statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
      const digests = JSON.parse(String(parameters[0])) as string[];
      return digests.flatMap((key) => table.get(key) ?? []) as unknown as Row[];
    },
  };
}

let root: string;
let previous_root: string | undefined;
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "oakridge-prompt-root-"));
  mkdirSync(resolve(root, "workflow-config/prompts/dev-flow"), { recursive: true });
  previous_root = process.env.OAKRIDGE_PROMPT_ROOT;
  process.env.OAKRIDGE_PROMPT_ROOT = root;
});
afterEach(() => {
  if (previous_root === undefined) delete process.env.OAKRIDGE_PROMPT_ROOT;
  else process.env.OAKRIDGE_PROMPT_ROOT = previous_root;
  rmSync(root, { recursive: true, force: true });
});

test("a pinned prompt resolves from stored content after its file is edited", async () => {
  const pinned = "Build the brief.\n";
  writeFileSync(resolve(root, PATH), "Build the brief, revised.\n");
  const resolved = await resolveBundlePrompts(promptStore([{ content_digest: digest(pinned), content: pinned }]), bundleWith(digest(pinned)), "start_run");
  expect(resolved).toEqual({ ok: true, value: [{ content_digest: digest(pinned), content: pinned }] });
});

test("an unpinned prompt is read from its authored file", async () => {
  const authored = "Assess the build.\n";
  writeFileSync(resolve(root, PATH), authored);
  const resolved = await resolveBundlePrompts(promptStore([]), bundleWith(digest(authored)), "pin_definition");
  expect(resolved).toEqual({ ok: true, value: [{ content_digest: digest(authored), content: authored }] });
});

test("an unpinned prompt whose file drifted from its digest is rejected", async () => {
  writeFileSync(resolve(root, PATH), "Edited after generation.\n");
  const resolved = await resolveBundlePrompts(promptStore([]), bundleWith(digest("Generated.\n")), "pin_definition");
  expect(resolved.ok ? null : resolved.error.operation).toBe("pin_definition");
});

test("rendering reads stored prompt text and never falls back to the file", async () => {
  const authored = "Integrate the cohorts.\n";
  writeFileSync(resolve(root, PATH), authored);
  const stored = await readStoredPrompts(promptStore([]), bundleWith(digest(authored)), ["build"]);
  expect(stored.ok ? null : stored.error.detail).toBe("pinned prompt content is not stored");
});

test("rendering returns the stored text for each selected prompt key", async () => {
  const pinned = "Write the plan.\n";
  const stored = await readStoredPrompts(promptStore([{ content_digest: digest(pinned), content: pinned }]), bundleWith(digest(pinned)), ["build", "build"]);
  expect(stored.ok ? [...stored.value] : null).toEqual([["build", pinned]]);
});
