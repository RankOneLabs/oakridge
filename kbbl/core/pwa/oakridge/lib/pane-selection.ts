import type { RunWorkspacePane, RunWorkspaceState } from "./run-workspace";

export interface PaneSlots {
  inPrimary: boolean;
  inSecondary: boolean;
}

export function paneSelectionClass({ inPrimary, inSecondary }: PaneSlots): string {
  if (!inPrimary && !inSecondary) return "";
  return "border-[var(--or-run-accent,var(--accent-primary))]! bg-[var(--bg-elevated)]!" +
    (inPrimary ? " border-l-4!" : "") + (inSecondary ? " border-r-4!" : "");
}

export function paneSelectionName({ inPrimary, inSecondary }: PaneSlots): "primary" | "secondary" | "both" | undefined {
  return inPrimary ? (inSecondary ? "both" : "primary") : inSecondary ? "secondary" : undefined;
}

export function selectPaneSlots(state: RunWorkspaceState, matches: (pane: RunWorkspacePane) => boolean): PaneSlots {
  return { inPrimary: matches(state.primary), inSecondary: state.secondary !== null && matches(state.secondary) };
}
