import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const pwaRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bareVariant = /\bvariant\s*=\s*(?:\{\s*)?["']bare["'](?:\s*\})?/;

async function sourceFilesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") return sourceFilesBelow(path);
    return entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

it("reserves the bare Button variant for CompactControl", async () => {
  const files = await sourceFilesBelow(pwaRoot);
  const sources = await Promise.all(files.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  const users = sources.filter(({ source }) => bareVariant.test(source))
    .map(({ path }) => relative(pwaRoot, path));
  expect(users).toEqual(["components/molecules/CompactControl.tsx"]);
});
