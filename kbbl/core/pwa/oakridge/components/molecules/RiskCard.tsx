import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";

interface Props {
  description: string;
  mitigation: string;
}

export function RiskCard({ description, mitigation }: Props) {
  return (
    <div className="rounded-md border border-[var(--amber-border)] bg-[var(--amber-bg)] px-3 py-2" data-testid="or-risk-card">
      <ExpandableText text={description} className="text-sm font-medium text-[var(--text-primary)]" />
      <div className={`${artifactLabelClass} mt-2`}>Mitigation</div>
      <ExpandableText text={mitigation} className="text-sm text-[var(--text-secondary)]" />
    </div>
  );
}
