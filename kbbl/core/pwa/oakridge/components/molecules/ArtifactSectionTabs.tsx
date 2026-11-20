import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";
import { selectKeyedSection, subnavSectionLabel, type SectionTabsState, type SubnavSection } from "../../lib/artifact-subnav";

interface Props<Section extends string> {
  label: string;
  sections: readonly SubnavSection<Section>[];
  initial: Section;
  /** Every section's content. All stay mounted and only the selected one is shown, so drafts and filters survive a switch. */
  children: (state: SectionTabsState<Section>) => Readonly<Record<Section, ReactNode>>;
}

/** An artifact viewer's section subnav, in the Settings subnav look, with one section shown below it at a time. */
export function ArtifactSectionTabs<Section extends string>({ label, sections, initial, children }: Props<Section>) {
  const baseId = useId();
  // Follows `initial` until the operator picks a section, so a default that settles after mount, such as an open review's, still applies.
  const [chosen, setActive] = useState<Section | null>(null);
  const active = chosen ?? initial;
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(null);
  const tabId = (section: Section) => `${baseId}-tab-${section}`;
  const panelId = (section: Section) => `${baseId}-panel-${section}`;
  // A link into another section switches first; its target is shown only after that render.
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
  // Arrow keys, Home and End move the selection and focus with it; only the selected tab is in the Tab order.
  function moveSelection(event: KeyboardEvent<HTMLDivElement>) {
    const next = selectKeyedSection(sections, active, event.key);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    document.getElementById(tabId(next))?.focus();
  }
  const panels = children(state);
  return <>
    <div role="tablist" aria-label={label} onKeyDown={moveSelection} className="flex items-end gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--border-decorative)]" data-testid="or-artifact-subnav">
      {sections.map((section) => {
        const isSelected = section.value === active;
        return <Button key={section.value} id={tabId(section.value)} variant="subnav-tab" role="tab" aria-selected={isSelected} aria-controls={panelId(section.value)}
          tabIndex={isSelected ? 0 : -1} data-section={section.value} onClick={() => setActive(section.value)}>{subnavSectionLabel(section)}</Button>;
      })}
    </div>
    {sections.map((section) => <div key={section.value} id={panelId(section.value)} role="tabpanel" aria-labelledby={tabId(section.value)}
      hidden={section.value !== active}>{panels[section.value]}</div>)}
  </>;
}
