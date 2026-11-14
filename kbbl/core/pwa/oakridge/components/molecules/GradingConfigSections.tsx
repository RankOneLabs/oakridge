import { Button } from "../../../components/atoms/Button";
import type { ObservationJsonValue as Json } from "../../grading-contracts/domain/primitives";
import type { ObservationGradingCatalogue } from "../../grading-contracts/http/grading-config";
import { atPath, catalogueArtifactKinds, catalogueEvidenceCapability, catalogueEvidenceNames, catalogueItemSelectors, catalogueRunners, definitionWithScope, definitionWithTaskSource, evaluatorWithRunner, jsonList, jsonObject, jsonText, type GradingPath } from "../../lib/grading-config";
import { GradingSelect, GradingTextField, type GradingEdit } from "./GradingConfigFields";

export interface GradingSectionProps {
  readonly definition: Json;
  readonly catalogue: ObservationGradingCatalogue;
  readonly onEdit: GradingEdit;
  readonly jsonField: (label: string, path: GradingPath) => React.ReactNode;
}
export function GradingConfigQuestion({ definition, onEdit, jsonField }: GradingSectionProps) {
  const question = jsonObject(jsonObject(definition).question);
  return <div className="grid gap-3">
    <GradingTextField label="Question text" value={question.text} onChange={(value) => onEdit(["question", "text"], value)} />
    <Button size="small" onClick={() => onEdit(["question", "text"], null)}>Set text to null</Button>
    <GradingSelect label="Response type" value={question.response} options={["boolean", "choice", "ordinal", "numeric", "text", "structured"]} onChange={(value) => onEdit(["question", "response"], value)} />
    {jsonField("Allowed values (JSON list or null)", ["question", "values"])}
    <GradingSelect label="Missing evidence policy" value={question.missing_evidence_policy} options={["fail", "abstain"]} onChange={(value) => onEdit(["question", "missing_evidence_policy"], value)} />
    {(["abstain_semantics", "unclear_semantics", "interpretation_caveats"] as const).map((field) => <GradingTextField key={field} label={field.replaceAll("_", " ")} value={question[field]} onChange={(value) => onEdit(["question", field], value)} />)}
  </div>;
}
export function GradingConfigTargets({ definition, catalogue, onEdit, jsonField }: GradingSectionProps) {
  const object = jsonObject(definition), targets = jsonList(object.targets);
  return <div className="grid gap-3">
    <GradingSelect label="Scope" value={object.scope} options={["per_item", "per_task"]} onChange={(value) => onEdit([], definitionWithScope(definition, value))} />
    {object.scope === "per_task" && <GradingSelect label="Task source" value={object.task_source ?? "task_ids"} options={["task_ids", "resolved_assesses"]} onChange={(value) => onEdit([], definitionWithTaskSource(definition, value))} />}
    {object.scope === "per_task" && object.task_source !== "resolved_assesses" && <GradingTextField label="Task pointer (task_ids JSON pointer)" value={object.task_ids} onChange={(value) => onEdit(["task_ids"], value)} />}
    {targets.map((target, index) => <div key={index} className="grid gap-2 rounded border border-[var(--border-muted)] p-3">
      <GradingSelect label={`Artifact kind ${index + 1}`} value={jsonObject(target).artifact} options={catalogueArtifactKinds(catalogue)} onChange={(value) => onEdit(["targets", index, "artifact"], value)} />
      <GradingSelect label={`Item selector ${index + 1}`} value={jsonObject(target).selector} options={catalogueItemSelectors(catalogue, jsonObject(target).artifact)} onChange={(value) => onEdit(["targets", index, "selector"], value)} />
      <Button size="small" variant="danger" onClick={() => onEdit(["targets"], targets.filter((_, position) => position !== index))}>Remove target {index + 1}</Button>
    </div>)}
    <Button onClick={() => onEdit(["targets"], [...targets, { artifact: catalogue.selectors[0]?.artifact_kind ?? "", selector: catalogue.selectors[0]?.item_selector ?? "" }])}>Add target</Button>
    {jsonField("Targets JSON", ["targets"])}
  </div>;
}
export function GradingConfigEvidence({ definition, catalogue, onEdit, jsonField }: GradingSectionProps) {
  const evidence = jsonList(jsonObject(definition).evidence);
  return <div className="grid gap-3">{evidence.map((reference, index) => {
    const name = typeof reference === "string" ? reference : jsonText(jsonObject(reference).capability);
    const capability = catalogueEvidenceCapability(catalogue, name);
    return <div key={index} className="grid gap-2 rounded border border-[var(--border-muted)] p-3">
      <GradingSelect label={`Evidence capability ${index + 1}`} value={name} options={catalogueEvidenceNames(catalogue)} onChange={(value) => onEdit(["evidence", index], typeof reference === "string" ? value : { ...jsonObject(reference), capability: value })} />
      {typeof reference === "string" ? <Button onClick={() => onEdit(["evidence", index], { capability: name, params: {} })}>Add optional params</Button> : <>
        {jsonField(`Evidence params ${index + 1} (JSON)`, ["evidence", index, "params"])}
        <Button onClick={() => onEdit(["evidence", index], name)}>Remove optional params</Button>
      </>}
      <details><summary>Parameter JSON Schema</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(capability?.params_schema ?? null, null, 2)}</pre></details>
      <Button variant="danger" onClick={() => onEdit(["evidence"], evidence.filter((_, position) => position !== index))}>Remove evidence {index + 1}</Button>
    </div>;
  })}<Button onClick={() => onEdit(["evidence"], [...evidence, catalogue.evidence_capabilities[0]?.name ?? ""])}>Add evidence</Button></div>;
}
export function GradingConfigEvaluators({ definition, catalogue, onEdit, jsonField }: GradingSectionProps) {
  const evaluators = jsonList(jsonObject(definition).evaluators);
  return <div className="grid gap-4">{evaluators.map((entry, index) => {
    const evaluator = jsonObject(entry), runner = jsonText(evaluator.runner), path: GradingPath = ["evaluators", index];
    const instructionsPath: GradingPath = [...path, "instructions"];
    const recipe = atPath(definition, [...instructionsPath, "system_one"]);
    return <div key={index} className="grid gap-3 rounded border border-[var(--border-muted)] p-3">
      <h4>Evaluator {index + 1}</h4>
      <GradingSelect label={`Runner ${index + 1}`} value={runner} options={catalogueRunners(catalogue)} onChange={(value) => onEdit(path, evaluatorWithRunner(entry, value))} />
      {runner !== "human" && <>
        <GradingTextField label={`Model ${index + 1}`} value={evaluator.model} onChange={(value) => onEdit([...path, "model"], value)} />
        {jsonField(`Estimated cost per call ${index + 1} (JSON number)`, [...path, "estimated_cost_per_call"])}
        {runner === "llm_judge" ? <>
          <GradingTextField label={`Rubric ${index + 1}`} value={atPath(definition, [...instructionsPath, "rubric"])} onChange={(value) => onEdit([...instructionsPath, "rubric"], value)} />
          {jsonField(`Max evidence chars ${index + 1} (integer 1..32000)`, [...instructionsPath, "max_evidence_chars"])}
        </> : runner === "jev_direct" || runner === "fastino_glide" ? <>
          <GradingSelect label={`System One type ${index + 1}`} value={jsonObject(recipe).type} options={["choice", "score", "noul"]} onChange={(value) => onEdit([...instructionsPath, "system_one", "type"], value)} />
          <GradingTextField label={`System One instructions ${index + 1}`} value={jsonObject(recipe).instructions} onChange={(value) => onEdit([...instructionsPath, "system_one", "instructions"], value)} />
          <p>{jsonObject(recipe).type === "score" ? "Score criteria: JSON list of at least two strings." : jsonObject(recipe).type === "noul" ? "Optional noul criteria: JSON object with true and false descriptions." : "Choice criteria: JSON object mapping each answer to a description."}</p>
          {jsonField(`Criteria ${index + 1} (JSON)`, [...instructionsPath, "system_one", "criteria"])}
          {jsonField(`State fields ${index + 1} (optional JSON)`, [...instructionsPath, "state_fields"])}
        </> : jsonField(`Instructions ${index + 1} (JSON)`, instructionsPath)}
      </>}
      <Button variant="danger" onClick={() => onEdit(["evaluators"], evaluators.filter((_, position) => position !== index))}>Remove evaluator {index + 1}</Button>
    </div>;
  })}<Button onClick={() => onEdit(["evaluators"], [...evaluators, { runner: "human" }])}>Add evaluator</Button></div>;
}
