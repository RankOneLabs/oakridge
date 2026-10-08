import type { Theme } from "../../types";

export type PrimarySurface = "runs" | "sessions" | "attention";

interface PrimaryNavProps {
  activeSurface: PrimarySurface;
  attentionCount: number;
  onNavigate: (surface: PrimarySurface) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

function navItemClass(isActive: boolean): string {
  return isActive
    ? "app-surface-nav__item app-surface-nav__item--active"
    : "app-surface-nav__item";
}

export function PrimaryNav({ activeSurface, attentionCount, onNavigate, theme, onToggleTheme }: PrimaryNavProps) {
  const toggleLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <nav className="app-surface-nav" aria-label="Primary">
      <span className="app-surface-nav__brand">oakridge</span>
      <button type="button" className={navItemClass(activeSurface === "runs")} onClick={() => onNavigate("runs")}>Runs</button>
      <button type="button" className={navItemClass(activeSurface === "sessions")} onClick={() => onNavigate("sessions")}>Sessions</button>
      <button type="button" className={navItemClass(activeSurface === "attention")} onClick={() => onNavigate("attention")}>
        Attention
        {attentionCount > 0 && <span className="app-surface-nav__count">{attentionCount}</span>}
      </button>
      <button
        type="button"
        className="theme-toggle app-surface-nav__theme"
        onClick={onToggleTheme}
        title={toggleLabel}
        aria-label={toggleLabel}
      >
        {theme === "dark" ? "LIGHT" : "DARK"}
      </button>
    </nav>
  );
}
