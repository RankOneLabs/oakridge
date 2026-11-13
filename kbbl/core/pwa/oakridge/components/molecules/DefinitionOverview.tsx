import { Button } from "../../../components/atoms/Button";
import type { DefinitionOverview as Overview } from "../../lib/definition-overview";
import { definitionSchemaElementId, definitionStageHref, definitionUnitHref } from "../../lib/definition-selection";

interface DefinitionOverviewProps { overview: Overview }
function SchemaType({ text, overview }: { text: string; overview: Overview }) {
  return <>{text.split(/([A-Za-z_][A-Za-z_0-9]*)/).map((part, index) => overview.schemas.some((schema) => schema.key === part)
    ? <Button variant="link" className="or-definition-link" key={index} onClick={() => {
      const entry = document.getElementById(definitionSchemaElementId(part));
      entry?.scrollIntoView({ block: "nearest" }); entry?.focus();
    }}>{part}</Button> : part)}</>;
}
export function DefinitionOverview({ overview }: DefinitionOverviewProps) {
  return <section aria-label="Workflow overview" className="or-definition-overview">
    <h2>{overview.name}</h2><p>Definition ID: <code>{overview.id}</code></p>
    <h3>Root input</h3>{typeof overview.input === "string"
      ? <p><SchemaType text={overview.input} overview={overview} /></p>
      : <dl>{Object.entries(overview.input).map(([field, type]) => <div key={field}><dt>{field}</dt><dd><code><SchemaType text={typeof type === "string" ? type : JSON.stringify(type)} overview={overview} /></code></dd></div>)}</dl>}
    <h3>Root outputs</h3><dl>{Object.entries(overview.outputs).map(([name, expression]) => <div key={name}><dt>{name}</dt><dd><code>{expression}</code></dd></div>)}</dl>
    <h3>Units</h3><ul>{overview.units.map((unit) => <li key={unit.path}>
      <a href={definitionUnitHref(overview.id, unit.path)}>{unit.path}</a>{" · "}
      {unit.is_group ? <>group: {unit.children.map((path) => <a key={path} href={definitionUnitHref(overview.id, path)}>{path} </a>)}</>
        : unit.stage ? <a href={definitionStageHref(overview.id, unit.stage)}>{unit.stage}</a> : "No stage"}
      {unit.pool !== null && <span> · pool: {unit.pool}</span>}
      {unit.for_each !== null && <code> · for_each: {unit.for_each}</code>}
      {unit.key_expression !== null && <code> · key: {unit.key_expression}</code>}
      {unit.after !== null && <code> · after: {unit.after}</code>}
    </li>)}</ul>
    <h3>Stages</h3><ol>{overview.stages.map((stage) => <li key={stage}><a href={definitionStageHref(overview.id, stage)}>{stage}</a></li>)}</ol>
    <h3>Pools</h3><ul>{overview.pools.map((pool) => <li key={JSON.stringify([pool.scope, pool.name])}>
      {pool.scope ? pool.scope + "/" : ""}{pool.name}: {pool.capacity} ← {pool.units.map((path) => <a key={path} href={definitionUnitHref(overview.id, path)}>{path} </a>)}
    </li>)}</ul>
    <h3>Collections</h3><ul>{overview.collections.map((unit) => <li key={unit.path}><a href={definitionUnitHref(overview.id, unit.path)}>{unit.path}</a>: <code>for_each: {unit.for_each} · key: {unit.key_expression ?? "not present"}</code></li>)}</ul>
    <h3>Nested groups</h3><ul>{overview.groups.map((unit) => <li key={unit.path}><a href={definitionUnitHref(overview.id, unit.path)}>{unit.path}</a> → {unit.children.map((path) => <a key={path} href={definitionUnitHref(overview.id, path)}>{path} </a>)}</li>)}</ul>
    <h3>Schemas</h3>{overview.schemas.map((schema) => <section key={schema.key} id={definitionSchemaElementId(schema.key)} tabIndex={-1}>
      <h4>{schema.key}</h4><pre>{JSON.stringify(schema.shape, null, 2)}</pre>
    </section>)}
  </section>;
}

export function DefinitionSelectionSummary({ overview, selection }: DefinitionOverviewProps & { selection: import("../../../lib/hash").DefinitionSelection | null }) {
  if (!selection) return <p>Select a stage or unit to inspect its declaration.</p>;
  if (selection.kind === "stage") {
    if (!overview.stages.includes(selection.stage)) return <p>Stage {selection.stage} is not in this definition.</p>;
    return <><h3>Stage: {selection.stage}</h3><p>Invoked by:</p><ul>{overview.units.filter((unit) => unit.stage === selection.stage).map((unit) => <li key={unit.path}><a href={definitionUnitHref(overview.id, unit.path)}>{unit.path}</a></li>)}</ul></>;
  }
  const unit = overview.units.find((unit) => unit.path === selection.path);
  if (!unit) return <p>Unit {selection.path} is not in this definition.</p>;
  return <><h3>Unit: {unit.path}</h3>
    {unit.is_group ? <p>group: {unit.children.map((path) => <a key={path} href={definitionUnitHref(overview.id, path)}>{path} </a>)}</p> : unit.stage && <p>Stage: <a href={definitionStageHref(overview.id, unit.stage)}>{unit.stage}</a></p>}
    <dl>{([["pool", unit.pool], ["for_each", unit.for_each], ["key", unit.key_expression], ["after", unit.after]] as const).map(([name, value]) => value !== null && <div key={name}><dt>{name}</dt><dd><code>{value}</code></dd></div>)}</dl>
  </>;
}
