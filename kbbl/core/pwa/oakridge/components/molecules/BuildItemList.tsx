import type { BuildBrief } from "../../lib/build-brief";
import type { ViewerProps } from "../../artifactRegistry";
import { ArtifactSection } from "./ArtifactSection";
import { TaskIdLink } from "./TaskIdLink";
import { ArtifactItemGrade } from "./ArtifactItemGrade";

interface Props extends Pick<ViewerProps, "source" | "onOpenTask" | "onOpenItem" | "itemGrading"> {
  brief: Extract<BuildBrief, { shape: "build_items" }>;
}
export function BuildItemList({ brief, source, onOpenTask, onOpenItem, itemGrading }: Props) {
  return <ArtifactSection title="Build items" testId="or-brief-build-items">
    <ul className="m-0 list-none space-y-3 p-0">{brief.build_items.map((item, index) => <li key={item.id}>
      <div className="flex justify-between gap-2"><code>{item.id}</code><ArtifactItemGrade source={source} itemPath={`/build_items/${index}`} onOpenItem={onOpenItem} itemGrading={itemGrading} /></div>
      <p>{item.description}</p>
      <div>{item.task_ids.map((id) => <TaskIdLink key={id} task_id={id} text={id} onOpenTask={onOpenTask} />)}</div>
      <ul>{item.decision_ids.map((id) => <li key={id}>{id}: {brief.decisions_made.find((decision) => decision.id === id)?.decision ?? "Unresolved"}</li>)}</ul>
      <div>Verification expectations</div><ul>{item.verification.map((text, number) => <li key={number}>{text}</li>)}</ul>
    </li>)}</ul>
  </ArtifactSection>;
}
