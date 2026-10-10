import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PWA_DIR = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const sourceFiles = collectSourceFiles(PWA_DIR);
const shellFiles = sourceFiles.filter((file) => {
  const relative = path.relative(PWA_DIR, file);
  return relative.startsWith(`oakridge${path.sep}`) || relative.startsWith(`review${path.sep}`);
});

describe("Oakridge styling criteria", () => {
  it("renders raw buttons only in the Button atom", () => {
    const offenders = shellFiles.filter((file) => /<button\b/.test(fs.readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(PWA_DIR, file))).toEqual([]);
  });

  it("does not emit retired Oakridge button and chip classes", () => {
    const legacyClass = /(?:className|class)\s*=\s*(?:["'`]|\{)[^\n]*(?:or-btn|or-chip|or-decision-button|or-secondary-button|or-link)\b/;
    const offenders = sourceFiles.filter((file) => legacyClass.test(fs.readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(PWA_DIR, file))).toEqual([]);
  });

  it("does not put CSS variables in inline style objects", () => {
    const inlineVar = /style=\{\{[^}]*var\(--/;
    const offenders = shellFiles.filter((file) => inlineVar.test(fs.readFileSync(file, "utf8").replace(/<Handle[\s\S]*?\/>/g, "")));
    expect(offenders.map((file) => path.relative(PWA_DIR, file))).toEqual([]);
  });

  it("defines exactly one of each shared atom", () => {
    for (const name of ["Button", "Chip", "FeedbackMessage", "StatusBadge"]) {
      const definition = new RegExp(`export (?:function|const) ${name}\\b`);
      const definitions = sourceFiles.filter((file) => definition.test(fs.readFileSync(file, "utf8")));
      expect(definitions.map((file) => path.relative(PWA_DIR, file))).toHaveLength(1);
    }
  });
});
