import type { OakridgeSubRoute, SettingsSubRoute } from "../../lib/hash";

export type SettingsNavItem = "status" | "workflows" | "grading";

export interface SettingsNavEntry {
  item: SettingsNavItem;
  href: string;
  label: string;
}

export const SETTINGS_NAV: readonly SettingsNavEntry[] = [
  { item: "status", href: "#settings/status", label: "Status" },
  { item: "workflows", href: "#settings/workflows", label: "Workflows" },
  { item: "grading", href: "#settings/workflows/grading-config", label: "Grading" },
];

/** The Settings sub-nav entry a route belongs to; null for routes outside Settings. */
export function selectSettingsNavItem(route: OakridgeSubRoute | SettingsSubRoute): SettingsNavItem | null {
  switch (route.sub) {
    case "status": return "status";
    case "workflows":
    case "workflow": return "workflows";
    case "grading-config": return "grading";
    default: return null;
  }
}
