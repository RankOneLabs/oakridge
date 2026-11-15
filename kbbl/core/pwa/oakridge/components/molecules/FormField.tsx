import type { ReactNode } from "react";

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
