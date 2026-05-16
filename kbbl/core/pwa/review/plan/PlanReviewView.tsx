import type { Theme } from "../../App";

interface PlanReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

export function PlanReviewView({ id, onBack }: PlanReviewViewProps) {
  return (
    <div style={{ padding: 24, fontFamily: "inherit" }}>
      <button type="button" onClick={onBack} style={{ marginBottom: 16 }}>
        Back
      </button>
      <div>Loading plan {id}…</div>
    </div>
  );
}
