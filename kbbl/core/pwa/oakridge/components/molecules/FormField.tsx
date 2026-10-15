import type { ReactNode } from "react";

export const formControlClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

interface FormFieldProps {
  children: ReactNode;
  hint?: ReactNode;
  label: ReactNode;
}

export function FormField({ children, hint, label }: FormFieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}
