import type { Theme } from "../../App";

interface BriefReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

export function BriefReviewView({ id, onBack }: BriefReviewViewProps) {
  return (
    <div style={{ padding: 24, fontFamily: "inherit" }}>
      <button type="button" onClick={onBack} style={{ marginBottom: 16 }}>
        Back
      </button>
      <div>Loading brief {id}…</div>
    </div>
  );
}
