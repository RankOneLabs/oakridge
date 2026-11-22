import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkflowNameFile } from "./check-workflow-names";

test("reports a workflow property access and a stage literal with locations", () => {
  const directory = mkdtempSync(join(tmpdir(), "oakridge-workflow-name-"));
  try {
    const file = join(directory, "integration.ts");
    writeFileSync(file, "const action = x.next_actions;\nconst stage = 'drafting';\n");
    expect(checkWorkflowNameFile(file, readFileSync(file, "utf8"), new Set(["next_actions", "drafting"]))).toEqual([
      `${file}:1 next_actions`,
      `${file}:2 drafting`,
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
