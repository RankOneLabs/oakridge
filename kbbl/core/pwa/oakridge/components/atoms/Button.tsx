import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger";
type ButtonSize = "small" | "medium";

const BASE_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-blue)] disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-[var(--accent-blue)] text-white",
  secondary:
    "border border-[var(--border-muted)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--border-hover)]",
  danger:
    "border border-[var(--danger-card-border)] bg-[var(--danger-bg)] text-[var(--danger-fg)]",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  small: "px-2.5 py-1 text-xs",
  medium: "px-3 py-1.5 text-sm",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function Button({
  children,
  className = "",
  size = "medium",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE_CLASS} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
