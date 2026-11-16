import type { ContractRendererProps } from "../../artifactRegistry";
import type { OperatorType } from "../../operator-contracts/core-client/core-types";
import { selectResolvedContractType } from "../../lib/artifact-contracts";
import { definitionStageHref } from "../../lib/definition-selection";

export function SchemaContractView({ schema, schemas, definition_id }: ContractRendererProps) {
  function render(type: OperatorType, visited: ReadonlySet<string>): React.ReactNode {
    switch (type.kind) {
      case "record": return <dl>{Object.entries(type.fields).map(([name, value]) => <div key={name}><dt>{name} · {selectResolvedContractType(value, schemas).kind === "optional" ? "optional" : "required"}</dt><dd>{render(value, visited)}</dd></div>)}</dl>;
      case "named": return visited.has(type.schema) || !schemas?.[type.schema] ? <code>{type.schema}</code> : <div>{type.schema}{render(schemas[type.schema], new Set([...visited, type.schema]))}</div>;
      case "list": return <>list({render(type.item, visited)})</>;
      case "optional": return <>optional({render(type.value, visited)})</>;
      case "enum": return <>enum({type.variants.join(" | ")})</>;
      case "outcome_of": return <a href={definitionStageHref(definition_id, type.stage)}>outcome_of({type.stage})</a>;
      default: return <code>{type.kind}</code>;
    }
  }
  return <div>{render(schema, new Set())}</div>;
}
