import { useEffect, useState } from "react";

import {
  COLLAPSED_KEY,
  EXPANDED_PROJECTS_KEY,
  EXPANDED_SPECS_KEY,
  readCollapsed,
  readExpandedProjects,
  readExpandedSpecs,
} from "../lib/sidebar";

export interface SidebarStorage {
  collapsed: boolean;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  expandedProjects: Set<string>;
  setExpandedProjects: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleProject: (id: string) => void;
  expandedSpecs: Set<string>;
  toggleSpec: (id: string) => void;
}

export function useSidebarStorage(): SidebarStorage {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(readExpandedProjects);
  const [expandedSpecs, setExpandedSpecs] = useState<Set<string>>(readExpandedSpecs);

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

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_SPECS_KEY, JSON.stringify([...expandedSpecs]));
    } catch {}
  }, [expandedSpecs]);

  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSpec = (id: string) => {
    setExpandedSpecs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return {
    collapsed,
    setCollapsed,
    expandedProjects,
    setExpandedProjects,
    toggleProject,
    expandedSpecs,
    toggleSpec,
  };
}
