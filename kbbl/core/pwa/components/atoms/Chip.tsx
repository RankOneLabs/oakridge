import type { ReactNode } from "react";

export type ChipTone = "neutral" | "muted" | "info" | "success" | "warning" | "danger" | "accent";

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "border-[var(--tone-muted-border)] bg-[var(--tone-muted-bg)] text-[var(--text-secondary)]",
  muted: "border-[var(--tone-muted-border)] bg-[var(--tone-muted-bg)] text-[var(--tone-muted-fg)]",
  info: "border-[var(--tone-info-border)] bg-[var(--tone-info-bg)] text-[var(--tone-info-fg)]",
  success: "border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] text-[var(--tone-success-fg)]",
  warning: "border-[var(--tone-warning-border)] bg-[var(--tone-warning-bg)] text-[var(--tone-warning-fg)]",
  danger: "border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] text-[var(--tone-danger-fg)]",
  accent: "border-[var(--accent-primary)] bg-[var(--accent-muted)] text-[var(--accent-primary)]",
};

interface ChipProps {
  tone: ChipTone;
  children: ReactNode;
  testId?: string;
  className?: string;
}

export function Chip({ tone, children, testId, className = "" }: ChipProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border shadow-[var(--badge-elevation)] before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-[''] px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`.trim()} data-testid={testId}>
      {children}
    </span>
  );
}
