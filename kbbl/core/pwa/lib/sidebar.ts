import type { SidebarProject, SidebarSession } from "../sidebar/Sidebar";

// Match a session to a project by longest repo_path prefix on workdir.
// Sessions don't carry a project_id; the workdir/repo_path link is the
// best we can do without a schema change. Longest-prefix wins so a repo
// nested under another repo doesn't double-count its sessions.
//
// Use a path-segment boundary check so /repo/app2 doesn't match /repo/app —
// raw startsWith would otherwise mis-attribute sibling directories whose
// names happen to share a prefix.
function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

function isWorkdirInProject(workdir: string, repoPath: string): boolean {
  const w = stripTrailingSep(workdir);
  const r = stripTrailingSep(repoPath);
  if (w === r) return true;
  return w.startsWith(`${r}/`) || w.startsWith(`${r}\\`);
}

export function indexSessionsByProject(
  sessions: SidebarSession[],
  projects: SidebarProject[],
): Map<string, SidebarSession[]> {
  const byProject = new Map<string, SidebarSession[]>();
  const sortedProjects = [...projects].sort(
    (a, b) => b.repo_path.length - a.repo_path.length,
  );
  for (const s of sessions) {
    const match = sortedProjects.find((p) => isWorkdirInProject(s.workdir, p.repo_path));
    if (!match) continue;
    const list = byProject.get(match.id) ?? [];
    list.push(s);
    byProject.set(match.id, list);
  }
  return byProject;
}

export const COLLAPSED_KEY = "oakridge.sidebar.collapsed";
export const EXPANDED_PROJECTS_KEY = "oakridge.sidebar.expandedProjects";

export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function readExpandedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}
