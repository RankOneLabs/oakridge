export type PrimarySurface = "runs" | "sessions" | "attention";

interface PrimaryNavProps {
  activeSurface: PrimarySurface;
  attentionCount: number;
  onNavigate: (surface: PrimarySurface) => void;
}

function navItemClass(isActive: boolean): string {
  return isActive
    ? "app-surface-nav__item app-surface-nav__item--active"
    : "app-surface-nav__item";
}

export function PrimaryNav({ activeSurface, attentionCount, onNavigate }: PrimaryNavProps) {
  return (
    <nav className="app-surface-nav" aria-label="Primary">
      <span className="app-surface-nav__brand">oakridge</span>
      <button type="button" className={navItemClass(activeSurface === "runs")} onClick={() => onNavigate("runs")}>Runs</button>
      <button type="button" className={navItemClass(activeSurface === "sessions")} onClick={() => onNavigate("sessions")}>Sessions</button>
      <button type="button" className={navItemClass(activeSurface === "attention")} onClick={() => onNavigate("attention")}>
        Attention
        {attentionCount > 0 && <span className="app-surface-nav__count">{attentionCount}</span>}
      </button>
    </nav>
  );
}
