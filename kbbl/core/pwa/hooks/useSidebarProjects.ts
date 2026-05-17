import { useCallback, useEffect, useRef, useState } from "react";

import type { SidebarProject, SidebarSpec } from "../sidebar/Sidebar";

export interface SidebarProjectsState {
  projects: SidebarProject[];
  specsByProject: Map<string, SidebarSpec[]>;
  loading: boolean;
  error: string | null;
  refreshProjects: () => Promise<void>;
  refreshSpecs: (projectId: string) => Promise<void>;
}

export function useSidebarProjects(expandedProjects: Set<string>): SidebarProjectsState {
  const [projects, setProjects] = useState<SidebarProject[]>([]);
  const [specsByProject, setSpecsByProject] = useState<Map<string, SidebarSpec[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
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

  const refreshSpecs = useCallback(async (projectId: string) => {
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
    void refreshProjects();
  }, [refreshProjects]);

  // Lazily fetch specs for newly-expanded projects only. Re-fetching every
  // expanded project on every set change would re-hit the API for project A
  // every time the user toggles project B. AddSpecModal.onCreated calls
  // refreshSpecs(created.id) explicitly to refresh post-create, so this
  // effect only needs to cover the "just expanded for the first time this
  // mount" case.
  const previouslyExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of expandedProjects) {
      if (!previouslyExpandedRef.current.has(id)) {
        void refreshSpecs(id);
      }
    }
    previouslyExpandedRef.current = new Set(expandedProjects);
  }, [expandedProjects, refreshSpecs]);

  return { projects, specsByProject, loading, error, refreshProjects, refreshSpecs };
}
