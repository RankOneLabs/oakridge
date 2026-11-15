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
const sourceFiles = ["components", "oakridge/components", "views", "oakridge/views"].flatMap((dir) => collectSourceFiles(path.join(PWA_DIR, dir)));
interface SourceImport { specifier: string; isType: boolean; target: string }
function selectImports(file: string): SourceImport[] {
  const source = fs.readFileSync(file, "utf8");
  return [...source.matchAll(/\bimport\s+(type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/g)].map((match) => ({
    specifier: match[2], isType: Boolean(match[1]),
    target: match[2].startsWith(".") ? path.relative(PWA_DIR, path.resolve(path.dirname(file), match[2])).replace(/\\/g, "/") : match[2],
  }));
}
function isDataImport(target: string): boolean {
  return /(^|\/)hooks\//.test(target) || /^oakridge\/client(?:-[^/]+)?(?:\.tsx?)?$/.test(target) || /^state\/store(?:\.tsx?)?$/.test(target);
}
function selectTierFiles(tier: string): string[] {
  return sourceFiles.filter((file) => new RegExp(`^(?:oakridge/)?components/${tier}/`).test(path.relative(PWA_DIR, file)));
}
function importOffenders(tier: string): string[] {
  return selectTierFiles(tier).flatMap((file) => selectImports(file).filter((entry) =>
    (tier === "molecules" && /(^|\/)organisms\//.test(entry.target)) || (!entry.isType && isDataImport(entry.target)),
  ).map((entry) => `${path.relative(PWA_DIR, file)}: ${entry.specifier}`));
}
describe("atomic tier boundaries", () => {
  it("keeps atoms independent of data and hooks", () => {
    const calls = selectTierFiles("atoms").flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/\b(use[A-Z]\w*)\(/g)].map((match) => `${path.relative(PWA_DIR, file)}: ${match[1]}`));
    expect([...importOffenders("atoms"), ...calls]).toEqual([]);
  });
  it("keeps molecules independent of organisms and data", () => {
    expect(importOffenders("molecules")).toEqual([]);
  });
  it("defines one exported component per view", () => {
    const offenders = sourceFiles.filter((file) => /^(?:oakridge\/)?views\//.test(path.relative(PWA_DIR, file))).flatMap((file) => {
      const components = [...fs.readFileSync(file, "utf8").matchAll(/^(export\s+)?(?:function\s+([A-Z]\w*)\b|const\s+([A-Z]\w*)\s*=)/gm)];
      return components.length === 1 && components[0][1] ? [] : (components.length ? components.map((match) => `${path.relative(PWA_DIR, file)}: ${match[2] ?? match[3]}`) : [`${path.relative(PWA_DIR, file)}: missing component`]);
    });
    expect(offenders).toEqual([]);
  });
});
