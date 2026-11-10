import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "armed" | "accent-outline" | "danger-strong" | "link" | "sidebar-row" | "pane-action" | "progress-row";
type ButtonSize = "xsmall" | "small" | "medium";

const BASE_CLASS =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-blue)] disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "border border-[var(--accent-blue)] bg-[var(--accent-blue)] font-bold text-[var(--accent-contrast-fg)] hover:brightness-110",
  secondary:
    "border border-[var(--border-muted)] bg-[var(--bg-surface)] font-normal text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]",
  danger:
    "border border-[var(--tone-danger-border)] bg-transparent text-[var(--tone-danger-fg)] hover:bg-[var(--tone-danger-fg)] hover:text-[var(--bg-app)]",
  armed: "border border-[var(--danger-fg)] bg-[var(--danger-bg)] font-semibold text-[var(--danger-fg)]",
  "accent-outline": "border border-[var(--accent-blue)] bg-transparent text-[var(--accent-blue)] hover:bg-[var(--accent-blue)] hover:text-[var(--accent-contrast-fg)]",
  "danger-strong": "border border-[var(--tone-danger-border)] bg-transparent text-[var(--tone-danger-fg)] hover:bg-[var(--tone-danger-fg)] hover:text-[var(--bg-app)]",
  link: "border-0 bg-transparent p-0 text-[var(--accent-blue)] underline hover:text-[var(--text-primary)]",
  "sidebar-row": "flex flex-1 min-w-0 flex-col gap-[0.15rem] rounded-[0.4rem] border border-transparent bg-transparent px-2 py-[0.4rem] text-left text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--bg-elevated)]",
  "pane-action": "rounded-[0.4rem] border border-[var(--border-subtle)] bg-transparent px-[0.45rem] py-[0.2rem] text-xs! text-[var(--text-muted)] cursor-pointer",
  "progress-row": "grid w-full grid-cols-[auto_minmax(0,1fr)_minmax(10rem,auto)_auto] items-center gap-4 min-h-[4.25rem] rounded-none border-0 border-b border-b-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 text-left text-[var(--text-primary)] cursor-pointer hover:bg-[var(--bg-elevated)] last:border-b-0 max-[767px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[767px]:gap-3",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xsmall: "px-2 py-0.5 text-xs",
  small: "px-2.5 py-1 text-xs",
  medium: "px-3 py-1.5 text-sm",
};

// These surfaces own their complete button geometry in the utilities layer.
const CUSTOM_SURFACE_VARIANTS: ReadonlySet<ButtonVariant> = new Set(["sidebar-row", "pane-action", "progress-row"]);

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
      className={`${CUSTOM_SURFACE_VARIANTS.has(variant) ? VARIANT_CLASS[variant] : `${BASE_CLASS} ${VARIANT_CLASS[variant]} ${variant === "link" ? "" : SIZE_CLASS[size]} ${primaryLabelClass}`} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
