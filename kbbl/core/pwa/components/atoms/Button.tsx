import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "accent-outline" | "danger-strong" | "link" | "bare";
type ButtonSize = "xsmall" | "small" | "medium";

const BASE_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-blue)] disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "border border-[var(--accent-blue)] bg-[var(--accent-blue)] font-bold text-[#0b130d] hover:brightness-110 [[data-theme=light]_&]:text-white",
  secondary:
    "border border-[var(--border-muted)] bg-[var(--bg-surface)] font-normal text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]",
  danger:
    "border border-red-500 bg-transparent text-red-500 hover:bg-red-500 hover:text-white",
  "accent-outline": "border border-[var(--accent-blue)] bg-transparent text-[var(--accent-blue)] hover:bg-[var(--accent-blue)] hover:text-white",
  "danger-strong": "border border-red-800 bg-red-800 text-white hover:bg-red-700 dark:border-red-400 dark:bg-red-400 dark:text-red-950 dark:hover:bg-red-300",
  link: "border-0 bg-transparent p-0 text-[var(--accent-blue)] underline hover:text-[var(--text-primary)]",
  bare: "",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xsmall: "px-2 py-0.5 text-xs",
  // The form's small source toggles inherited its old shell button reset.
  small: [
    "px-2.5 py-1 text-xs",
    "[.or-form-card_&]:min-h-[2.65rem]! [.or-form-card_&]:rounded-[0.5rem]!",
    "[.or-form-card_&]:border-[var(--border-muted)]! [.or-form-card_&]:bg-[var(--bg-surface)]!",
    "[.or-form-card_&]:px-[0.8rem]! [.or-form-card_&]:py-[0.45rem]!",
    "[.or-form-card_&]:text-[var(--text-secondary)]!",
  ].join(" "),
  // Preserve the shell's existing control geometry while its raw buttons migrate.
  medium: [
    "px-3 py-1.5 text-sm",
    "[.or-shell_&]:min-h-10 [.or-shell_&]:rounded-[0.45rem]",
    "[.or-shell_&]:px-[0.8rem] [.or-shell_&]:py-[0.45rem]",
    "[.or-page-actions_&]:min-h-[2.65rem]! [.or-page-actions_&]:rounded-[0.5rem]!",
    "[.or-page-header>_&]:min-h-[2.65rem]! [.or-page-header>_&]:rounded-[0.5rem]!",
    "[.or-form-card_&]:min-h-[2.65rem]! [.or-form-card_&]:rounded-[0.5rem]!",
  ].join(" "),
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
  // styles.css has an unlayered `button { font: inherit }` rule, so the
  // primary label needs priority to retain the existing dark-theme weight.
  const primaryLabelClass = variant === "primary" && size === "medium" ? "font-bold!" : "";
  return (
    <button
      type={type}
      className={`or-tw-button ${variant === "bare" ? "" : `${BASE_CLASS} ${VARIANT_CLASS[variant]} ${variant === "link" ? "" : SIZE_CLASS[size]} ${primaryLabelClass}`} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
