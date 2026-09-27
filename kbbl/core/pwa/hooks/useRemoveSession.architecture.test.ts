import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pwaRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sourceFilesBelow = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<readonly string[]> => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  }));
  return nested.flat();
};

describe("session purge architecture", () => {
  it("keeps the guarded purge DELETE in useRemoveSession and the stop DELETE distinct", async () => {
    const sources = await sourceFilesBelow(pwaRoot);
    const reads = await Promise.all(sources.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
    const purgeDeleteSites = reads
      .filter(({ source }) => source.includes("purge=true") && /method\s*:\s*["']DELETE["']/.test(source))
      .map(({ path }) => relative(pwaRoot, path));

    expect(purgeDeleteSites).toEqual(["hooks/useRemoveSession.ts"]);

    const inputBox = reads.find(({ path }) => relative(pwaRoot, path) === "components/organisms/InputBox.tsx");
    expect(inputBox?.source).toContain("method: \"DELETE\"");
    expect(inputBox?.source).not.toContain("purge=true");
  });
});
