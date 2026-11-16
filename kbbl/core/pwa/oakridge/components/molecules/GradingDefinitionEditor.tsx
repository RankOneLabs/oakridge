import type { ObservationJsonValue as Json } from "../../grading-contracts/domain/primitives";
import type { ObservationConfigurationIssue } from "../../grading-contracts/grading/configuration";
import type { GradingSectionProps } from "./GradingConfigSections";
import { GradingConfigEvidence, GradingConfigEvaluators, GradingConfigQuestion, GradingConfigTargets } from "./GradingConfigSections";
import { GradingTextField } from "./GradingConfigFields";
import { definitionIssues, jsonObject, sectionIssues } from "../../lib/grading-config";
interface GradingDefinitionEditorProps extends GradingSectionProps {
  readonly index: number;
  readonly issues: readonly ObservationConfigurationIssue[];
}
export function GradingDefinitionEditor(props: GradingDefinitionEditorProps) {
  const sections = [
    { title: "Question", path: "question", component: GradingConfigQuestion },
    { title: "Targets", path: "targets", component: GradingConfigTargets },
    { title: "Evidence", path: "evidence", component: GradingConfigEvidence },
    { title: "Evaluators", path: "evaluators", component: GradingConfigEvaluators },
  ];
  return <div data-testid="grading-definition-editor" className="min-w-0 [overflow-wrap:anywhere] grid gap-4">
    {definitionIssues(props.issues, props.index).map((issue, index) => <p role="alert" key={index}>{issue.detail}</p>)}
    <div role="group" aria-label="Definition id field" className="min-w-0 [overflow-wrap:anywhere] grid gap-1">
      <GradingTextField label="Definition id" value={jsonObject(props.definition).id} onChange={(value: Json) => props.onEdit(["id"], value)} />
      {sectionIssues(props.issues, props.index, ["id"]).map((issue, index) => <p role="alert" key={index}>{issue.detail}</p>)}
    </div>
    {sections.map(({ title, path, component: Section }) => <section key={path} aria-label={title} className="min-w-0 [overflow-wrap:anywhere] grid gap-3 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4">
      <h3 className="min-w-0 [overflow-wrap:anywhere] text-lg font-semibold">{title}</h3>
      {sectionIssues(props.issues, props.index, [path]).map((issue, index) => <p role="alert" key={index}>{issue.path.join(".")}: {issue.detail}</p>)}
      {path === "targets" && sectionIssues(props.issues, props.index, ["task_source"]).concat(sectionIssues(props.issues, props.index, ["task_ids"])).concat(sectionIssues(props.issues, props.index, ["scope"])).map((issue, index) => <p role="alert" key={index}>{issue.detail}</p>)}
      <Section {...props} />
    </section>)}
  </div>;
}
