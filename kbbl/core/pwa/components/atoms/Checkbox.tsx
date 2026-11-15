import type { InputHTMLAttributes, Ref } from "react";

interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  type: "checkbox" | "radio";
  ref?: Ref<HTMLInputElement>;
  variant?: "default" | "editing";
}

const VARIANT_CLASS = {
  default: "accent-[var(--accent-primary)]",
  editing: "accent-[var(--accent-primary)]",
};

export function Checkbox({ type, variant = "default", className = "", ...props }: CheckboxProps) {
  return <input type={type} className={`${VARIANT_CLASS[variant]} ${className}`.trim()} {...props} />;
}
