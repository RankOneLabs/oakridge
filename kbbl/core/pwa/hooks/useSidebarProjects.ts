import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SidebarCohort, SidebarProject, SidebarSpec } from "../sidebar/Sidebar";

export interface SidebarProjectsState {
  projects: SidebarProject[];
  specsByProject: Map<string, SidebarSpec[]>;
  cohortsByPlan: Map<string, SidebarCohort[]>;
  cohortErrorsByPlan: Map<string, string>;
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
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async (): Promise<SidebarProject[]> => {
      const res = await fetch("/projects");
      if (!res.ok) throw new Error(`projects ${res.status}`);
      return (await res.json()) as SidebarProject[];
    },
  });

  // One specs query per expanded project — useQueries handles in-flight
  // cancellation when the set changes. Cache keys mirror the route shape
  // so AddSpecModal's mutation invalidation lands on the right entry.
  const expandedProjectIds = useMemo(
    () => [...expandedProjects],
    [expandedProjects],
  );
  const specsQueries = useQueries({
    queries: expandedProjectIds.map((projectId) => ({
      queryKey: ["specs", { projectId }] as const,
      queryFn: async (): Promise<SidebarSpec[]> => {
        const res = await fetch(`/specs?project_id=${encodeURIComponent(projectId)}`);
        if (!res.ok) return [];
        return (await res.json()) as SidebarSpec[];
      },
    })),
  });

  const specsByProject = useMemo(() => {
    const m = new Map<string, SidebarSpec[]>();
    expandedProjectIds.forEach((id, i) => {
      const data = specsQueries[i]?.data;
      if (data) m.set(id, data);
    });
    return m;
  }, [expandedProjectIds, specsQueries]);

  // Resolve expanded spec ids → plan ids. Only specs we have loaded with a
  // non-null plan_id qualify; the rest stay out of the cohort query list and
  // re-evaluate once specsByProject populates.
  const planIdsToFetch = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const specId of expandedSpecs) {
      for (const list of specsByProject.values()) {
        const found = list.find((s) => s.id === specId);
        if (found?.plan_id && !seen.has(found.plan_id)) {
          ids.push(found.plan_id);
          seen.add(found.plan_id);
          break;
        }
      }
    }
    return ids;
  }, [expandedSpecs, specsByProject]);

  const cohortsQueries = useQueries({
    queries: planIdsToFetch.map((planId) => ({
      queryKey: ["cohorts", { planId }] as const,
      queryFn: async (): Promise<SidebarCohort[]> => {
        const res = await fetch(`/cohorts?plan_id=${encodeURIComponent(planId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as SidebarCohort[];
      },
    })),
  });

  const cohortsByPlan = useMemo(() => {
    const m = new Map<string, SidebarCohort[]>();
    planIdsToFetch.forEach((id, i) => {
      const data = cohortsQueries[i]?.data;
      if (data) m.set(id, data);
    });
    return m;
  }, [planIdsToFetch, cohortsQueries]);

  // Errors are tracked separately from data so the UI can distinguish
  // "fetch failed, retry available" from "this plan really has no cohorts".
  const cohortErrorsByPlan = useMemo(() => {
    const m = new Map<string, string>();
    planIdsToFetch.forEach((id, i) => {
      const q = cohortsQueries[i];
      if (q?.isError) {
        m.set(id, q.error instanceof Error ? q.error.message : "network error");
      }
    });
    return m;
  }, [planIdsToFetch, cohortsQueries]);

  const refreshProjects = async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
  };
  const refreshSpecs = async (projectId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["specs", { projectId }] });
  };
  const refreshCohorts = async (planId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["cohorts", { planId }] });
  };

  return {
    projects: projectsQuery.data ?? [],
    specsByProject,
    cohortsByPlan,
    cohortErrorsByPlan,
    loading: projectsQuery.isPending,
    error:
      projectsQuery.error instanceof Error
        ? projectsQuery.error.message
        : projectsQuery.error
          ? "failed to load projects"
          : null,
    refreshProjects,
    refreshSpecs,
    refreshCohorts,
  };
}
