import type { ReactNode } from "react";

export const artifactLabelClass = "text-[0.6875rem] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]";

interface Props {
  title: string;
  testId: string;
  children: ReactNode;
}

/** A titled block of an artifact viewer. */
export function ArtifactSection({ title, testId, children }: Props) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h3 className={artifactLabelClass}>{title}</h3>
      {children}
    </section>
  );
}
