interface StatusBadgeProps {
  status: string;
  testId?: string;
}

function statusClass(status: string): string {
  const base = "inline-block rounded border bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium";
  if (status === "failed") return `${base} border-red-500 text-red-500`;
  if (status === "parked") return `${base} border-amber-500 text-amber-500`;
  if (status === "complete") return `${base} border-emerald-500 text-emerald-500`;
  if (status === "running") return `${base} border-blue-500 text-blue-500`;
  return `${base} border-[var(--border-muted)] text-[var(--text-muted)]`;
}

export function StatusBadge({ status, testId }: StatusBadgeProps) {
  return <span className={statusClass(status)} data-testid={testId}>{status}</span>;
}
