import type { ReactNode } from "react";

interface PageHeaderProps {
  actions?: ReactNode;
  backAction?: ReactNode;
  eyebrow: string;
  summary: string;
  title: ReactNode;
}

export function PageHeader({ actions, backAction, eyebrow, summary, title }: PageHeaderProps) {
  return (
    <header className={`or-page-header${backAction ? " or-page-header--back" : ""}`}>
      {backAction}
      <div>
        <span className="or-page-kicker">{eyebrow}</span>
        <h2 className="or-page-title">{title}</h2>
        <p className="or-page-summary">{summary}</p>
      </div>
      {actions && <div className="or-page-actions">{actions}</div>}
    </header>
  );
}
