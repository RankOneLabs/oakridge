import { useMemo, useState } from "react";

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
  const { collapsed, setCollapsed, expandedProjects, setExpandedProjects, toggleProject } =
    useSidebarStorage();
  const { projects, specsByProject, loading, error, refreshProjects, refreshSpecs } =
    useSidebarProjects(expandedProjects);

  const [showAddProject, setShowAddProject] = useState(false);
  const [addSpecProject, setAddSpecProject] = useState<SidebarProject | null>(null);

  const sessionsByProject = useMemo(
    () => indexSessionsByProject(sessions, projects),
    [sessions, projects],
  );

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
