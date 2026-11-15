import type { TextareaHTMLAttributes, Ref } from "react";

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
  variant?: "default" | "editing";
}

const VARIANT_CLASS = {
  default: "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  editing: "w-full rounded-md border border-[var(--accent-primary)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm! text-[var(--text-primary)]",
};

export function TextArea({ variant = "default", className = "", ...props }: TextAreaProps) {
  return <textarea className={`${VARIANT_CLASS[variant]} ${className}`.trim()} {...props} />;
}
