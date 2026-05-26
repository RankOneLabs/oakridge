import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Hono } from "hono";

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

export interface DirectoriesRouteDeps {
  defaultWorkdir: string | null;
}

function fallbackStartPath(defaultWorkdir: string | null): string {
  if (defaultWorkdir !== null) return defaultWorkdir;
  const home = homedir();
  return home === "" ? "/" : home;
}

async function listDirectories(path: string): Promise<DirectoryListing> {
  if (!isAbsolute(path)) {
    throw new Error("path must be absolute");
  }

  const resolvedPath = resolve(path);
  const pathStat = await stat(resolvedPath);
  if (!pathStat.isDirectory()) {
    throw new Error("path is not a directory");
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: resolve(resolvedPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(resolvedPath);

  return {
    path: resolvedPath,
    parent: parent === resolvedPath ? null : parent,
    entries: directories,
  };
}

export function mountDirectoriesRoutes(app: Hono, deps: DirectoriesRouteDeps): void {
  app.get("/directories", async (c) => {
    const requestedPath = c.req.query("path") ?? fallbackStartPath(deps.defaultWorkdir);
    try {
      return c.json(await listDirectories(requestedPath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });
}
