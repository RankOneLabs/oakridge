import type { ReactNode } from "react";

type FeedbackTone = "danger" | "muted";

const TONE_CLASS: Record<FeedbackTone, string> = {
  danger:
    "rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]",
  muted: "py-6 text-sm text-[var(--text-muted)]",
};

interface FeedbackMessageProps {
  children: ReactNode;
  className?: string;
  testId?: string;
  tone?: FeedbackTone;
}

export function FeedbackMessage({
  children,
  className = "",
  testId,
  tone = "muted",
}: FeedbackMessageProps) {
  return (
    <div
      className={`${TONE_CLASS[tone]} ${className}`.trim()}
      data-testid={testId}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
