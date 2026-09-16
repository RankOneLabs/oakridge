import type { ComponentPropsWithoutRef } from "react";

export type ButtonProps = ComponentPropsWithoutRef<"button">;

/** Shared interactive button primitive. */
export function Button({ type = "button", ...props }: ButtonProps) {
  return <button type={type} {...props} />;
}
