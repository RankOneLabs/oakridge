import { useCallback, useEffect, useMemo, useState } from "react";
import { AddProjectModal } from "./AddProjectModal";
import { AddSpecModal } from "./AddSpecModal";

export interface SidebarProject {
  id: string;
  name: string;
  repo_path: string;
}

export interface SidebarSpec {
  id: string;
  project_id: string;
  title: string;
  status: string;
}

export interface SidebarSession {
  sid: string;
  name: string;
  workdir: string;
  status: string;
}

interface SidebarProps {
  sessions: SidebarSession[];
  onSelectSession: (sid: string) => void;
}

// Match a session to a project by longest repo_path prefix on workdir.
// Sessions don't carry a project_id; the workdir/repo_path link is the
// best we can do without a schema change. Longest-prefix wins so a repo
// nested under another repo doesn't double-count its sessions.
function indexSessionsByProject(
  sessions: SidebarSession[],
  projects: SidebarProject[],
): Map<string, SidebarSession[]> {
  const byProject = new Map<string, SidebarSession[]>();
  const sortedProjects = [...projects].sort(
    (a, b) => b.repo_path.length - a.repo_path.length,
  );
  for (const s of sessions) {
    const match = sortedProjects.find((p) => s.workdir.startsWith(p.repo_path));
    if (!match) continue;
    const list = byProject.get(match.id) ?? [];
    list.push(s);
    byProject.set(match.id, list);
  }
  return byProject;
}

const COLLAPSED_KEY = "oakridge.sidebar.collapsed";
const EXPANDED_PROJECTS_KEY = "oakridge.sidebar.expandedProjects";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function readExpandedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function Sidebar({ sessions, onSelectSession }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(readExpandedProjects);
  const [projects, setProjects] = useState<SidebarProject[]>([]);
  const [specsByProject, setSpecsByProject] = useState<Map<string, SidebarSpec[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [addSpecProject, setAddSpecProject] = useState<SidebarProject | null>(null);

  const fetchProjects = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/projects");
      if (!res.ok) throw new Error(`projects ${res.status}`);
      const data = (await res.json()) as SidebarProject[];
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSpecsFor = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/specs?project_id=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as SidebarSpec[];
      setSpecsByProject((prev) => {
        const next = new Map(prev);
        next.set(projectId, data);
        return next;
      });
    } catch {
      // network error — leave previous state; user can re-expand to retry
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Whenever a project is expanded we lazily fetch its specs. Re-fetch on
  // every expansion (cheap) so creating a new spec via the modal is reflected
  // the next time the operator toggles open the project.
  useEffect(() => {
    for (const id of expandedProjects) {
      void fetchSpecsFor(id);
    }
  }, [expandedProjects, fetchSpecsFor]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {}
  }, [collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedProjects]));
    } catch {}
  }, [expandedProjects]);

  const sessionsByProject = useMemo(
    () => indexSessionsByProject(sessions, projects),
    [sessions, projects],
  );

  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (collapsed) {
    return (
      <aside className="app-sidebar app-sidebar-collapsed">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          »
        </button>
      </aside>
    );
  }

  return (
    <aside className="app-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Projects</span>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          «
        </button>
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="sidebar-action"
          onClick={() => setShowAddProject(true)}
        >
          + Project
        </button>
      </div>

      {error && (
        <div className="sidebar-error" role="alert">
          {error}
        </div>
      )}

      <ul className="sidebar-tree">
        {loading && projects.length === 0 ? (
          <li className="sidebar-empty">loading…</li>
        ) : projects.length === 0 ? (
          <li className="sidebar-empty">No projects yet.</li>
        ) : (
          projects.map((p) => {
            const isOpen = expandedProjects.has(p.id);
            const projSessions = sessionsByProject.get(p.id) ?? [];
            const projSpecs = specsByProject.get(p.id) ?? [];
            return (
              <li key={p.id} className="sidebar-project">
                <button
                  type="button"
                  className="sidebar-project-row"
                  onClick={() => toggleProject(p.id)}
                  title={p.repo_path}
                >
                  <span className="sidebar-chevron">{isOpen ? "▾" : "▸"}</span>
                  <span className="sidebar-project-name">{p.name}</span>
                </button>
                {isOpen && (
                  <div className="sidebar-project-body">
                    <div className="sidebar-section">
                      <div className="sidebar-section-label">Sessions</div>
                      {projSessions.length === 0 ? (
                        <div className="sidebar-section-empty">none</div>
                      ) : (
                        <ul className="sidebar-section-list">
                          {projSessions.map((s) => (
                            <li key={s.sid}>
                              <button
                                type="button"
                                className="sidebar-leaf"
                                onClick={() => onSelectSession(s.sid)}
                                title={`${s.workdir}\n${s.sid}`}
                              >
                                <span className={`sidebar-leaf-dot sidebar-leaf-dot-${s.status}`} />
                                <span className="sidebar-leaf-label">
                                  {s.name || s.sid.slice(0, 8)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="sidebar-section">
                      <div className="sidebar-section-label">
                        Plans / Epics
                        <button
                          type="button"
                          className="sidebar-section-add"
                          onClick={() => setAddSpecProject(p)}
                          title="Create a plan/epic (spec) for this project"
                          aria-label="Create plan/epic"
                        >
                          +
                        </button>
                      </div>
                      {projSpecs.length === 0 ? (
                        <div className="sidebar-section-empty">none</div>
                      ) : (
                        <ul className="sidebar-section-list">
                          {projSpecs.map((s) => (
                            <li key={s.id}>
                              <div
                                className="sidebar-leaf sidebar-leaf-static"
                                title={`${s.title}\nstatus: ${s.status}`}
                              >
                                <span className="sidebar-leaf-label">{s.title}</span>
                                <span className="sidebar-leaf-status">{s.status}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })
        )}
      </ul>

      {showAddProject && (
        <AddProjectModal
          onCancel={() => setShowAddProject(false)}
          onCreated={() => {
            setShowAddProject(false);
            void fetchProjects();
          }}
        />
      )}
      {addSpecProject && (
        <AddSpecModal
          project={addSpecProject}
          onCancel={() => setAddSpecProject(null)}
          onCreated={() => {
            const created = addSpecProject;
            setAddSpecProject(null);
            // Expand the project and refresh its spec list so the new spec
            // is visible without an extra click.
            setExpandedProjects((prev) => {
              const next = new Set(prev);
              next.add(created.id);
              return next;
            });
            void fetchSpecsFor(created.id);
          }}
        />
      )}
    </aside>
  );
}
