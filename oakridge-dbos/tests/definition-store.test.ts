import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFINITION_STORE_ROOT, readLaunchableCatalog, resolveDefinition, resolveLaunchableDefinition, type DefinitionId } from "../src/runtime/definition-store";

function fixture(check: (root: string, id: DefinitionId) => void): void {
  const root = mkdtempSync("/tmp/authority-definitions-");
  try {
    cpSync(DEFINITION_STORE_ROOT, root, { recursive: true });
    const catalog = readLaunchableCatalog(root);
    if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
    check(root, Object.values(catalog.value)[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("resolves committed source, prompt bytes and operations without normalization", () => fixture((root, id) => {
  const result = resolveLaunchableDefinition(id, root);
  expect(result.ok && result.value.definition_id).toBe(id);
}));
test("refuses a definition absent from the launch catalog", () => fixture((root) => {
  const result = resolveLaunchableDefinition("0".repeat(64) as DefinitionId, root);
  expect(!result.ok && result.error.kind).toBe("definition_not_launchable");
}));
for (const [directory, extension, kind] of [["workflows", "json", "missing_definition"], ["prompts", "md", "missing_prompt"], ["operations", "json", "missing_operation_registry"]] as const) {
  test(`names ${kind} distinctly`, () => fixture((root, id) => {
    const object = JSON.parse(readFileSync(resolve(root, "workflows", `${id}.json`), "utf8"));
    const reference = directory === "workflows" ? id : directory === "prompts" ? Object.values(object.prompts)[0] : object.operation_registry_id;
    unlinkSync(resolve(root, directory, `${reference}.${extension}`));
    const result = resolveDefinition(id, root);
    expect(!result.ok && result.error.kind).toBe(kind);
  }));
}
test("refuses changed workflow bytes", () => fixture((root, id) => {
  writeFileSync(resolve(root, "workflows", `${id}.json`), "{}");
  const result = resolveDefinition(id, root);
  expect(!result.ok && result.error.kind).toBe("hash_mismatch");
}));
test("refuses symlinks escaping the root", () => fixture((root, id) => {
  const target = resolve(root, "workflows", `${id}.json`);
  unlinkSync(target);
  symlinkSync("/etc/passwd", target);
  const result = resolveDefinition(id, root);
  expect(!result.ok && result.error.kind).toBe("unsafe_path");
}));
for (const id of ["/etc/passwd", "../outside", "..\\outside"]) {
  test(`refuses unsafe identifier ${id}`, () => {
    const result = resolveDefinition(id as DefinitionId);
    expect(!result.ok && result.error.kind).toBe("malformed_object");
  });
}

test("malformed canonical objects fail by name after their hash is verified", () => fixture((root) => {
  const bytes = '{"source":true}';
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex") as DefinitionId;
  writeFileSync(resolve(root, "workflows", `${id}.json`), bytes);
  const result = resolveDefinition(id, root);
  expect(!result.ok && result.error.kind).toBe("malformed_object");
}));
test("noncanonical JSON is refused without normalizing its content", () => fixture((root) => {
  const bytes = '{ "source": true }\n';
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex") as DefinitionId;
  writeFileSync(resolve(root, "workflows", `${id}.json`), bytes);
  const result = resolveDefinition(id, root);
  expect(!result.ok && result.error.kind).toBe("malformed_object");
}));
test("changed prompt bytes fail their content hash", () => fixture((root, id) => {
  const object = JSON.parse(readFileSync(resolve(root, "workflows", `${id}.json`), "utf8"));
  const prompt = Object.values(object.prompts)[0];
  writeFileSync(resolve(root, "prompts", `${prompt}.md`), "changed\r\n");
  const result = resolveDefinition(id, root);
  expect(!result.ok && result.error.kind).toBe("hash_mismatch");
}));
