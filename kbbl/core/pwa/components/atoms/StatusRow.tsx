import type { ReactNode } from "react";

interface StatusRowProps {
  label: string;
  children: ReactNode;
  title?: string;
}

export function StatusRow({ label, children, title }: StatusRowProps) {
  return (
    <div className="status-row">
      <span className="status-row__label">{label}</span>
      <div className="status-row__value" title={title}>{children}</div>
    </div>
  );
}
