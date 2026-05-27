import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { Hono } from "hono";
import type { DirectoryListing } from "../../directories";

export interface DirectoriesRouteDeps {
  defaultWorkdir: string | null;
}

function fallbackStartPath(defaultWorkdir: string | null): string {
  if (defaultWorkdir !== null) return defaultWorkdir;
  const home = homedir();
  return home === "" ? "/" : home;
}

function isPathInside(child: string, parent: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function allowedRoots(defaultWorkdir: string | null): Promise<string[]> {
  const home = homedir();
  const fallbackRoot = home === "" ? "/" : home;
  const roots = [fallbackRoot, defaultWorkdir].filter(
    (path): path is string => typeof path === "string" && path !== "",
  );
  const resolved = await Promise.all(
    roots.map(async (root) => realpath(resolve(root)).catch(() => null)),
  );
  return [...new Set(resolved.filter((root): root is string => root !== null))];
}

async function listDirectories(path: string, roots: readonly string[]): Promise<DirectoryListing> {
  if (!isAbsolute(path)) {
    throw new Error("path must be absolute");
  }

  const resolvedPath = await realpath(resolve(path));
  if (!roots.some((root) => isPathInside(resolvedPath, root))) {
    throw new Error("path is outside allowed directory roots");
  }
  const pathStat = await stat(resolvedPath);
  if (!pathStat.isDirectory()) {
    throw new Error("path is not a directory");
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: resolve(resolvedPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(resolvedPath);
  const allowedParent = roots.some((root) => isPathInside(parent, root)) ? parent : null;

  return {
    path: resolvedPath,
    parent: parent === resolvedPath ? null : allowedParent,
    entries: directories,
  };
}

export function mountDirectoriesRoutes(app: Hono, deps: DirectoriesRouteDeps): void {
  app.get("/directories", async (c) => {
    const requestedPath = c.req.query("path") ?? fallbackStartPath(deps.defaultWorkdir);
    try {
      return c.json(await listDirectories(requestedPath, await allowedRoots(deps.defaultWorkdir)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });
}
