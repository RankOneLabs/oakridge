import { useCallback, useEffect, useRef, useState } from "react";

import type { SidebarCohort, SidebarProject, SidebarSpec } from "../sidebar/Sidebar";

export interface SidebarProjectsState {
  projects: SidebarProject[];
  specsByProject: Map<string, SidebarSpec[]>;
  cohortsByPlan: Map<string, SidebarCohort[]>;
  loading: boolean;
  error: string | null;
  refreshProjects: () => Promise<void>;
  refreshSpecs: (projectId: string) => Promise<void>;
  refreshCohorts: (planId: string) => Promise<void>;
}

export function useSidebarProjects(
  expandedProjects: Set<string>,
  expandedSpecs: Set<string>,
): SidebarProjectsState {
  const [projects, setProjects] = useState<SidebarProject[]>([]);
  const [specsByProject, setSpecsByProject] = useState<Map<string, SidebarSpec[]>>(new Map());
  const [cohortsByPlan, setCohortsByPlan] = useState<Map<string, SidebarCohort[]>>(new Map());
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

  const refreshCohorts = useCallback(async (planId: string) => {
    const writeTerminalIfEmpty = () => {
      // Always write a terminal value so SidebarSpecsSection can stop showing
      // `loading…`. If we already have data for this plan (e.g. a refresh that
      // raced a transient error), keep it — only seed an empty array when the
      // map has no entry yet.
      setCohortsByPlan((prev) => {
        if (prev.has(planId)) return prev;
        const next = new Map(prev);
        next.set(planId, []);
        return next;
      });
    };
    try {
      const res = await fetch(`/cohorts?plan_id=${encodeURIComponent(planId)}`);
      if (!res.ok) {
        writeTerminalIfEmpty();
        return;
      }
      const data = (await res.json()) as SidebarCohort[];
      setCohortsByPlan((prev) => {
        const next = new Map(prev);
        next.set(planId, data);
        return next;
      });
    } catch {
      writeTerminalIfEmpty();
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

  // Lazily fetch cohorts for newly-expanded specs. The spec list may not be
  // loaded yet when the user toggles expansion, so we keep "attempted" specs
  // out of the dedupe map until we actually fire the fetch — that way we
  // retry on the next render once specsByProject populates plan_id.
  //
  // Keyed by (specId → planId) so a plan reopen (which surfaces a new plan_id
  // on the same spec) invalidates the dedupe and re-fires the fetch.
  const fetchedCohortsForSpecRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const specId of expandedSpecs) {
      let planId: string | null = null;
      for (const list of specsByProject.values()) {
        const found = list.find((s) => s.id === specId);
        if (found?.plan_id) {
          planId = found.plan_id;
          break;
        }
      }
      if (!planId) continue;
      if (fetchedCohortsForSpecRef.current.get(specId) === planId) continue;
      fetchedCohortsForSpecRef.current.set(specId, planId);
      void refreshCohorts(planId);
    }
    // Drop entries for specs that were collapsed so re-expanding refetches.
    for (const specId of fetchedCohortsForSpecRef.current.keys()) {
      if (!expandedSpecs.has(specId)) fetchedCohortsForSpecRef.current.delete(specId);
    }
  }, [expandedSpecs, specsByProject, refreshCohorts]);

  return {
    projects,
    specsByProject,
    cohortsByPlan,
    loading,
    error,
    refreshProjects,
    refreshSpecs,
    refreshCohorts,
  };
}
