import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";
import { subnavSectionLabel, type SectionTabsState, type SubnavSection } from "../../lib/artifact-subnav";

interface Props<Section extends string> {
  label: string;
  sections: readonly SubnavSection<Section>[];
  initial: Section;
  children: (state: SectionTabsState<Section>) => ReactNode;
}

/** An artifact viewer's section subnav, in the Settings subnav look, with one section shown below it at a time. */
export function ArtifactSectionTabs<Section extends string>({ label, sections, initial, children }: Props<Section>) {
  const [active, setActive] = useState<Section>(initial);
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(null);
  // A link into another section switches first; its target exists only after that render.
  useEffect(() => {
    if (pendingAnchorId === null) return;
    const element = document.getElementById(pendingAnchorId);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setPendingAnchorId(null);
  }, [active, pendingAnchorId]);
  const state: SectionTabsState<Section> = {
    active,
    select: setActive,
    openAnchor: (section, anchor_id) => { setActive(section); setPendingAnchorId(anchor_id); },
  };
  return <>
    <div role="tablist" aria-label={label} className="flex items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--border-decorative)]" data-testid="or-artifact-subnav">
      {sections.map((section) => <Button key={section.value} variant="subnav-tab" role="tab" aria-selected={section.value === active} data-section={section.value}
        onClick={() => setActive(section.value)}>{subnavSectionLabel(section)}</Button>)}
    </div>
    <div role="tabpanel">{children(state)}</div>
  </>;
}
