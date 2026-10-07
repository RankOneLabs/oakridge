import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REVIEW_DIR = path.resolve(__dirname, "..");
const SELF = path.resolve(__filename);

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const sourceFiles = collectSourceFiles(REVIEW_DIR).filter((f) => f !== SELF);

describe("styling criteria", () => {
  it("no file uses bare CSS custom property tokens inline (the spec grep)", () => {
    // Matches var(--<token> where token does NOT start with a dash after the
    // category prefix — e.g. var(--surface) or var(--accent) but not
    // var(--surface-raised) or var(--accent-blue).
    const BARE_TOKEN = /var\(--(?:surface|accent|border|danger|success)(?!-)\b/;
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (BARE_TOKEN.test(content)) {
        violations.push(path.relative(REVIEW_DIR, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no file has inline style={{ … var(--…) … }} (the spec grep)", () => {
    // Matches a style prop containing a CSS variable reference.
    const INLINE_VAR = /style=\{\{[^}]*var\(/;
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (INLINE_VAR.test(content)) {
        violations.push(path.relative(REVIEW_DIR, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
