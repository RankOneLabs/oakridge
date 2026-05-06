/**
 * Italic muted message for empty / placeholder states. Used in the
 * cell list (no cells), the panel (no cell selected), and each tab
 * (no events / no artifact / no commits yet).
 */
import type { ReactNode } from "react";

export function EmptyMessage({ children }: { children: ReactNode }) {
  return <p className="p-6 italic text-stone-500">{children}</p>;
}
