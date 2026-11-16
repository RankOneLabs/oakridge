import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import { writeStoreFile } from "../../oakridge-dbos/src/runtime/definition-store";
import { bytesIdentity, jsonIdentity, type PromptVersionId } from "./definition-identity";
import { readPromptVersion, readPromptPointer } from "./prompt-versions";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function unwrap<T,E>(result: Result<T,E>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
test("runtime version bytes are read with the same content identity by the generator", () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-reader-")); roots.push(root);
  const object = { prompt_id: bytesIdentity(Buffer.from("body")), source_path: "development/brief.md" };
  const id = unwrap(jsonIdentity<PromptVersionId>(object));
  unwrap(writeStoreFile({ root, path: "prompt-versions/" + id + ".json", bytes: Buffer.from(unwrap(canonicalJson(object))) }));
  expect(unwrap(readPromptVersion(id, root))).toEqual(object);
  writeFileSync(resolve(root, "prompt-versions", id + ".json"), "{}");
  const altered = readPromptVersion(id, root);
  expect(altered.ok ? null : altered.error).toMatchObject({ kind: "hash_mismatch", detail: expect.stringContaining(id + ".json") });
});
test("pointer rejects altered canonical bytes and unsafe source paths", () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-pointer-")); roots.push(root);
  unwrap(writeStoreFile({ root, path: "prompt-pointers/development/brief.md.json", bytes: Buffer.from('{"source_path":"../bad"}') }));
  expect(readPromptPointer("development/brief.md", root).ok).toBe(false);
  expect(readPromptPointer("../bad", root).ok).toBe(false);
});
