import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, test, expect } from "bun:test";
import { loadPrompt, renderPrompt } from "./prompt-loader";

let tmpDir: string;
const origEnv = process.env.KBBL_PROMPTS_DIR;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kbbl-prompt-test-"));
  process.env.KBBL_PROMPTS_DIR = tmpDir;
});

afterEach(() => {
  if (origEnv === undefined) {
    delete process.env.KBBL_PROMPTS_DIR;
  } else {
    process.env.KBBL_PROMPTS_DIR = origEnv;
  }
});

describe("loadPrompt", () => {
  test("reads a file from KBBL_PROMPTS_DIR", () => {
    writeFileSync(join(tmpDir, "test.md"), "hello {{WORLD}}", "utf8");
    expect(loadPrompt("test.md")).toBe("hello {{WORLD}}");
  });

  test("throws when the file does not exist", () => {
    expect(() => loadPrompt("missing.md")).toThrow();
  });
});

describe("renderPrompt", () => {
  test("substitutes all slots", () => {
    const result = renderPrompt("hello {{NAME}}, you are {{AGE}}", { NAME: "alice", AGE: "30" });
    expect(result).toBe("hello alice, you are 30");
  });

  test("substitutes repeated slots", () => {
    const result = renderPrompt("{{X}} and {{X}}", { X: "foo" });
    expect(result).toBe("foo and foo");
  });

  test("throws on unfilled slots", () => {
    expect(() => renderPrompt("hello {{NAME}} and {{MISSING}}", { NAME: "alice" })).toThrow(
      "unfilled prompt slot: {{MISSING}}",
    );
  });

  test("does not throw when all slots are filled", () => {
    expect(renderPrompt("{{A}} {{B}}", { A: "1", B: "2" })).toBe("1 2");
  });

  test("treats empty slots as valid substitution targets", () => {
    expect(renderPrompt("prefix {{EMPTY}} suffix", { EMPTY: "" })).toBe("prefix  suffix");
  });

  test("does not treat literal mustache syntax in slot values as unfilled slots", () => {
    // Regression: a brief's rendered body can contain literal `{{X}}` text
    // (e.g. the planner agent quoted slot syntax in a decision). That must
    // not trip the unfilled-slot check, because the template's own slots
    // were all filled.
    const template = "Brief:\n{{BODY}}\nURL: {{URL}}";
    const result = renderPrompt(template, {
      BODY: "see {{PLAN_ID}} and {{KBBL_URL}}",
      URL: "http://kbbl",
    });
    expect(result).toBe("Brief:\nsee {{PLAN_ID}} and {{KBBL_URL}}\nURL: http://kbbl");
  });
});
