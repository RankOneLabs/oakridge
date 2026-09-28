import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "accent-outline" | "danger-strong" | "link" | "bare";
type ButtonSize = "xsmall" | "small" | "medium";

const BASE_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-blue)] disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-[var(--accent-blue)] text-white hover:brightness-110",
  secondary:
    "border border-[var(--border-muted)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]",
  danger:
    "border border-red-500 bg-transparent text-red-500 hover:bg-red-500 hover:text-white",
  "accent-outline": "border border-[var(--accent-blue)] bg-transparent text-[var(--accent-blue)] hover:bg-[var(--accent-blue)] hover:text-white",
  "danger-strong": "border border-red-800 bg-red-800 text-white hover:bg-red-700 dark:border-red-400 dark:bg-red-400 dark:text-red-950 dark:hover:bg-red-300",
  link: "border-0 bg-transparent p-0 text-[var(--accent-blue)] underline hover:text-[var(--text-primary)]",
  bare: "",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xsmall: "px-2 py-0.5 text-xs",
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
      className={`or-tw-button ${variant === "bare" ? "" : `${BASE_CLASS} ${VARIANT_CLASS[variant]} ${variant === "link" ? "" : SIZE_CLASS[size]}`} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
