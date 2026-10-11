import type { ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly title: string; readonly onBack: () => void; readonly children: ReactNode }
export function ArtifactReviewShell({ title, onBack, children }: Props) {
  return <section data-testid="or-artifact-review" className="or-page or-page--wide">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>← Overview</Button><h2 className="or-page-title">{title}</h2></header>
    {children}
  </section>;
}
