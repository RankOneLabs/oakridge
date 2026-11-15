import { selectBuildItemDecisions } from "../../lib/build-brief";
import type { BuildBrief } from "../../lib/build-brief";
import type { ViewerProps } from "../../artifactRegistry";
import { ArtifactSection } from "./ArtifactSection";
import { TaskIdLink } from "./TaskIdLink";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { BriefText, type Editor } from "./BriefText";

interface Props extends Pick<ViewerProps, "renderEditableText" | "source" | "onOpenTask" | "onOpenItem" | "itemGrading"> {
  brief: Extract<BuildBrief, { shape: "build_items" }>;
  /** Set while the brief is in edit mode: an item's description and verification steps edit at their exact paths. */
  editor?: Editor;
}
export function BuildItemList({ brief, editor = null, renderEditableText, source, onOpenTask, onOpenItem, itemGrading }: Props) {
  return <ArtifactSection title="Build items" testId="or-brief-build-items">
    <ul className="m-0 list-none space-y-3 p-0">{brief.build_items.map((item, index) => <li key={item.id}>
      <div className="flex justify-between gap-2"><code>{item.id}</code><ArtifactItemGrade source={source} itemPath={`/build_items/${index}`} onOpenItem={onOpenItem} itemGrading={itemGrading} /></div>
      <BriefText renderEditableText={renderEditableText} anchor={`/build_items/${index}/description`} value={item.description} editor={editor} isProse className="text-sm text-[var(--text-primary)]" />
      <div>{item.task_ids.map((id) => <TaskIdLink key={id} task_id={id} text={id} onOpenTask={onOpenTask} />)}</div>
      <ul>{selectBuildItemDecisions(brief, item).map(({ id, decision }) => <li key={id}>{id}: {decision ?? "Unresolved"}</li>)}</ul>
      <div>Verification expectations</div><ul>{item.verification.map((text, number) => <li key={number}><BriefText renderEditableText={renderEditableText} anchor={`/build_items/${index}/verification/${number}`} value={text} editor={editor} className="text-sm text-[var(--text-secondary)]" /></li>)}</ul>
    </li>)}</ul>
  </ArtifactSection>;
}
