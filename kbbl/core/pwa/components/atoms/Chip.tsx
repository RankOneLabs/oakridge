import type { ReactNode } from "react";

export type ChipTone = "neutral" | "muted" | "info" | "success" | "warning" | "danger" | "accent";

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "border-[var(--border-muted)] text-[var(--text-secondary)]",
  muted: "border-[var(--border-muted)] text-[var(--text-muted)]",
  info: "border-blue-500 text-blue-500",
  success: "border-emerald-500 text-emerald-500",
  warning: "border-amber-500 text-amber-500",
  danger: "border-red-500 text-red-500",
  accent: "border-[var(--accent-blue)] text-[var(--accent-blue)]",
};

interface ChipProps {
  tone: ChipTone;
  children: ReactNode;
  testId?: string;
  className?: string;
}

export function Chip({ tone, children, testId, className = "" }: ChipProps) {
  return (
    <span className={`inline-block rounded border bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`.trim()} data-testid={testId}>
      {children}
    </span>
  );
}
