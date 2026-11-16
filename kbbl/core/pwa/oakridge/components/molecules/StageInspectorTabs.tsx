import type { DefinitionSelection } from "../../../lib/hash";
import { STAGE_TABS, definitionTabHref, type StageTab } from "../../lib/definition-selection";
interface StageInspectorTabsProps { id: string; selection: DefinitionSelection; activeTab: StageTab }
export function StageInspectorTabs({ id, selection, activeTab }: StageInspectorTabsProps) {
  return <div role="tablist" aria-label="Stage sections" className="flex flex-wrap gap-3">
    {STAGE_TABS.map(tab => <a key={tab.value} role="tab" aria-selected={activeTab === tab.value} href={definitionTabHref(id, selection, tab.value)}>{tab.label}</a>)}
  </div>;
}
