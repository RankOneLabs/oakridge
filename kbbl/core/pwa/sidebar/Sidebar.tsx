import { useEffect, useMemo, useRef, useState } from "react";

import { AddProjectModal } from "./AddProjectModal";
import { AddSpecModal } from "./AddSpecModal";

import { SidebarProjectRow } from "../components/molecules/SidebarProjectRow";
import { useSidebarProjects } from "../hooks/useSidebarProjects";
import { useSidebarStorage } from "../hooks/useSidebarStorage";
import { indexSessionsByProject } from "../lib/sidebar";

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
  plan_id: string | null;
}

export interface SidebarCohort {
  id: string;
  plan_id: string;
  title: string;
  position: number;
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

export function Sidebar({ sessions, onSelectSession }: SidebarProps) {
  const {
    collapsed,
    setCollapsed,
    expandedProjects,
    setExpandedProjects,
    toggleProject,
    expandedSpecs,
    toggleSpec,
  } = useSidebarStorage();
  const {
    projects,
    specsByProject,
    cohortsByPlan,
    loading,
    error,
    refreshProjects,
    refreshSpecs,
  } = useSidebarProjects(expandedProjects, expandedSpecs);

  const [showAddProject, setShowAddProject] = useState(false);
  const [addSpecProject, setAddSpecProject] = useState<SidebarProject | null>(null);

  const sessionsByProject = useMemo(
    () => indexSessionsByProject(sessions, projects),
    [sessions, projects],
  );

  // Refresh an expanded project's specs when one of its sessions ends.
  // A planner1 session ending is what flips a draft spec to planning_done
  // and creates its first plan row; without this nudge the cached SidebarSpec
  // stays plan_id=null and SidebarSpecsSection keeps rendering the static
  // (non-clickable) variant until the page reloads.
  //
  // TODO(sidebar-stream): this only catches plan creation that coincides with
  // a local session ending. Plans created by another tab, by an external
  // process, or by a planner re-dispatch we didn't observe still won't appear
  // until reload. The real fix is a /project-stream SSE channel (snapshot +
  // delta on spec/plan writes, modeled on inboxHandler) consumed by a
  // useProjectStream hook. Tracked separately — ~400-500 LOC, own PR.
  const prevStatusBySidRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevStatusBySidRef.current;
    const projectsToRefresh = new Set<string>();
    for (const [projectId, projectSessions] of sessionsByProject) {
      if (!expandedProjects.has(projectId)) continue;
      for (const s of projectSessions) {
        const prior = prev.get(s.sid);
        if (prior !== "ended" && s.status === "ended") {
          projectsToRefresh.add(projectId);
        }
      }
    }
    const nextStatuses = new Map<string, string>();
    for (const s of sessions) nextStatuses.set(s.sid, s.status);
    prevStatusBySidRef.current = nextStatuses;
    for (const projectId of projectsToRefresh) {
      void refreshSpecs(projectId);
    }
  }, [sessions, sessionsByProject, expandedProjects, refreshSpecs]);

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
          projects.map((p) => (
            <SidebarProjectRow
              key={p.id}
              project={p}
              isOpen={expandedProjects.has(p.id)}
              onToggle={toggleProject}
              sessions={sessionsByProject.get(p.id) ?? []}
              specs={specsByProject.get(p.id) ?? []}
              cohortsByPlan={cohortsByPlan}
              expandedSpecs={expandedSpecs}
              onToggleSpec={toggleSpec}
              onSelectSession={onSelectSession}
              onAddSpec={setAddSpecProject}
            />
          ))
        )}
      </ul>

      {showAddProject && (
        <AddProjectModal
          onCancel={() => setShowAddProject(false)}
          onCreated={() => {
            setShowAddProject(false);
            void refreshProjects();
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
            void refreshSpecs(created.id);
          }}
        />
      )}
    </aside>
  );
}
