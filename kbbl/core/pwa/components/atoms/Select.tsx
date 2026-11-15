import type { SelectHTMLAttributes, Ref } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
  variant?: "default" | "editing";
}

const VARIANT_CLASS = {
  default: "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  editing: "w-full rounded-md border border-[var(--accent-primary)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm! text-[var(--text-primary)]",
};

export function Select({ variant = "default", className = "", ...props }: SelectProps) {
  return <select className={`${VARIANT_CLASS[variant]} ${className}`.trim()} {...props} />;
}
