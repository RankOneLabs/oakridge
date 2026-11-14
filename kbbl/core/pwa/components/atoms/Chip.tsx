import type { ReactNode } from "react";

export type ChipTone = "neutral" | "muted" | "info" | "success" | "warning" | "danger" | "accent";

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "border-[var(--badge-neutral-border)] bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-fg)]",
  muted: "border-[var(--badge-muted-border)] bg-[var(--badge-muted-bg)] text-[var(--badge-muted-fg)]",
  info: "border-[var(--badge-info-border)] bg-[var(--badge-info-bg)] text-[var(--badge-info-fg)]",
  success: "border-[var(--badge-success-border)] bg-[var(--badge-success-bg)] text-[var(--badge-success-fg)]",
  warning: "border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)] text-[var(--badge-warning-fg)]",
  danger: "border-[var(--badge-danger-border)] bg-[var(--badge-danger-bg)] text-[var(--badge-danger-fg)]",
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
